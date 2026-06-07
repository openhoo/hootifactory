import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  InvalidDigestError,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { buildBatchResponse } from "./gitlfs-batch";
import { LfsBatchRequestSchema, LfsOidSchema, oidToDigest } from "./gitlfs-validation";

/** Git LFS speaks this media type for the Batch and Locks JSON APIs. */
const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";
/** Stable CAS blob-ref kind + scope: LFS is one flat object store per repo. */
const LFS_BLOB_KIND = "gitlfs_object";
const LFS_BLOB_SCOPE = "lfs-objects";
/**
 * Cap on in-flight existence probes per batch. A batch may carry up to 1000
 * objects; fanning all of them out as concurrent DB queries in one request would
 * cause avoidable load spikes, so we drain the work through a small worker pool.
 */
const BATCH_PROBE_CONCURRENCY = 16;

/** An already-closed body for `PUT`s that carry no request stream (empty objects). */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight at once,
 * preserving the input order in the returned results.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      // `index < items.length` was just checked, so the element is present.
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function parseOid(oid: string): string {
  return parseRegistryInput(LfsOidSchema, oid, {
    code: "DIGEST_INVALID",
    message: "invalid LFS object id",
  });
}

function lfsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": LFS_CONTENT_TYPE },
  });
}

/**
 * Git LFS server. Git clients push/pull large blobs out-of-band of the git object
 * store: the client first hits `POST /objects/batch` to negotiate `upload`/`download`
 * actions, then `PUT`/`GET`s each object at `/objects/:oid` where `:oid` is the
 * object's sha256. Objects are flat and content-addressable, so they live directly
 * in the shared CAS keyed by `sha256:<oid>` — there is no version/tag aggregation.
 * The `/locks` endpoints satisfy the file-locking API with empty results.
 */
export class GitLfsAdapter implements RegistryPlugin {
  readonly id = "gitlfs" as const;
  // contentAddressable: objects are keyed by their sha256 oid.
  // resumableUploads: false — LFS basic transfer PUTs each object whole.
  // proxyable: false — Git LFS has no upstream-mirror semantics.
  // virtualizable: false — LFS is a flat object store with no aggregation semantics.
  readonly capabilities = registryCapabilities("contentAddressable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Git LFS",
      mountSegment: "lfs",
      errorResponseKind: "singleError",
      scan: {
        // Each stored version's metadata records the object's CAS digest.
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal/static routes declared before the `/objects/:oid` catch-all so the
      // matcher (which tries routes in order) cannot shadow them.
      route.post("/objects/batch", "batch", ({ req, ctx }) => this.batch(req, ctx)),
      route.post("/locks/verify", "locksVerify", () => this.locksVerify()),
      route.post("/locks", "locksCreate", () => this.locksCreate()),
      route.get("/locks", "locksList", () => this.locksList()),
      route.head("/objects/:oid", "headObject", ({ params, req, ctx }) =>
        this.getObject(params.oid, req, ctx, true),
      ),
      route.get(
        "/objects/:oid",
        "getObject",
        ({ params, req, ctx }) => this.getObject(params.oid, req, ctx, false),
        { immutableContentAddressed: true },
      ),
      route.put("/objects/:oid", "putObject", ({ params, req, ctx }) =>
        this.putObject(params.oid, req, ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  get displayName() {
    return this.plugin.displayName;
  }
  get mountSegment() {
    return this.plugin.mountSegment;
  }
  get repositoryNamePolicy() {
    return this.plugin.repositoryNamePolicy;
  }
  get acceptsRegistryBearerToken() {
    return this.plugin.acceptsRegistryBearerToken;
  }
  get apiKeyHeaders() {
    return this.plugin.apiKeyHeaders;
  }
  get errorResponseKind() {
    return this.plugin.errorResponseKind;
  }
  get compressibleHandlers() {
    return this.plugin.compressibleHandlers;
  }
  get compressibleContentTypes() {
    return this.plugin.compressibleContentTypes;
  }
  get scan() {
    return this.plugin.scan;
  }

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    // GET/HEAD read, PUT/POST write. The batch operation (upload vs download) lives
    // in the request body, not the route, so a pure (method, route) mapping cannot
    // tell them apart — POST therefore takes the safe write permission.
    const permission = readWritePermission(method);
    const oid = match?.params.oid;
    if (oid) return { ...permission, resource: { type: "artifact", artifactRef: oid } };
    return permission;
  }

  handle = this.delegate.handle;

  // ── batch ────────────────────────────────────────────────────────────────
  /** `POST /objects/batch` — negotiate `upload`/`download` actions per object. */
  private async batch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return lfsJson({ message: "request body is not valid JSON" }, 400);
    }
    const parsed = LfsBatchRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return lfsJson({ message: "invalid batch request" }, 422);
    }
    const { operation, objects } = parsed.data;

    // Probe the CAS once per object so the response can flag what is present.
    // Bound the fan-out (a batch may name up to 1000 objects) so a single request
    // cannot stampede the database with that many concurrent existence queries.
    const present = new Set<string>();
    await mapWithConcurrency(objects, BATCH_PROBE_CONCURRENCY, async (object) => {
      const exists = await ctx.data.content.blobRefExists({
        digest: oidToDigest(object.oid),
        kind: LFS_BLOB_KIND,
        scope: LFS_BLOB_SCOPE,
      });
      if (exists) present.add(object.oid);
    });

    const objectsBaseUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/objects`;
    const response = buildBatchResponse({
      operation,
      objects,
      objectsBaseUrl,
      exists: (oid) => present.has(oid),
    });
    return lfsJson(response, 200);
  }

  // ── objects ──────────────────────────────────────────────────────────────
  /** `GET|HEAD /objects/:oid` — serve the stored object content by oid. */
  private async getObject(
    oidRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
    headOnly: boolean,
  ): Promise<Response> {
    const oid = parseOid(oidRaw);
    return serveRegistryBlob(ctx, {
      digest: oidToDigest(oid),
      kind: LFS_BLOB_KIND,
      scope: LFS_BLOB_SCOPE,
      contentType: "application/octet-stream",
      redirect: !headOnly && req.method === "GET",
      blocked: () => lfsJson({ message: "object blocked by scan policy" }, 403),
      missing: () => lfsJson({ message: "object does not exist" }, 404),
    });
  }

  /** `PUT /objects/:oid` — upload object content; the body's sha256 must equal `oid`. */
  private async putObject(
    oidRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const oid = parseOid(oidRaw);
    const digest = oidToDigest(oid);
    // Stream the body straight into the CAS rather than buffering it in memory:
    // LFS objects can be many gigabytes, so `expectedDigest` lets the store hash
    // and verify the bytes as they flow (content addressing is only sound if the
    // uploaded bytes hash to the claimed oid). A mismatch surfaces as
    // `InvalidDigestError`, which we translate into the registry DIGEST_INVALID.
    try {
      await ctx.data.content.storeBlobStreamWithRef({
        data: req.body ?? emptyStream(),
        expectedDigest: digest,
        mediaType: "application/octet-stream",
        kind: LFS_BLOB_KIND,
        scope: LFS_BLOB_SCOPE,
        asset: {
          role: LFS_BLOB_KIND,
          digest,
          scope: LFS_BLOB_SCOPE,
          path: oid,
          mediaType: "application/octet-stream",
          metadata: { oid },
        },
      });
    } catch (err) {
      if (err instanceof InvalidDigestError) {
        throw Errors.digestInvalid({ expected: oid, error: err.message });
      }
      throw err;
    }
    // Wire the object into the scan pipeline (no-op when scanning is disabled).
    await ctx.enqueueScan({ digest, mediaType: "application/octet-stream" });
    return new Response(null, { status: 200 });
  }

  // ── locks ──────────────────────────────────────────────────────────────────
  // The file-locking API is optional; we implement it as a no-op so `git lfs`
  // clients that probe it succeed instead of erroring.
  /** `GET /locks` — list locks (always empty). */
  private locksList(): Response {
    return lfsJson({ locks: [], next_cursor: "" });
  }

  /** `POST /locks/verify` — the locks this client owns vs. others (always empty). */
  private locksVerify(): Response {
    return lfsJson({ ours: [], theirs: [], next_cursor: "" });
  }

  /**
   * `POST /locks` — create a lock. Locking is not backed by storage here, so we
   * report the feature as unavailable (501) rather than fabricate a lock id.
   */
  private locksCreate(): Response {
    return lfsJson({ message: "locking is not supported by this registry" }, 501);
  }
}

export const gitlfsRegistryPlugin: RegistryPlugin = new GitLfsAdapter();
