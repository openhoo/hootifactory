import {
  createRegistryAdapterPlugin,
  type HttpMethod,
  InvalidDigestError,
  type Permission,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryAdapter,
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

/**
 * Validate a path `:oid`. On success returns the oid; on failure returns an
 * LFS-shaped `{message}` error response (content-type `application/vnd.git-lfs+json`,
 * 422 Validation error) rather than throwing a generic RegistryError that the
 * framework would render in the non-LFS `singleError` shape.
 */
function parseOid(oid: string): string | Response {
  const parsed = LfsOidSchema.safeParse(oid);
  if (parsed.success) return parsed.data;
  return lfsJson({ message: "invalid LFS object id" }, 422);
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
 * The optional `/locks` file-locking endpoints are uniformly unsupported (404).
 */
class GitLfsAdapterState {
  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    // GET/HEAD read, PUT write. The batch operation (upload vs download) lives in the
    // request body, not the route, so a pure (method, route) mapping cannot tell them
    // apart. `POST /objects/batch` is the read/pull negotiation path for downloads
    // (`git lfs pull`, `git clone`) as well as the push path for uploads — gating it on
    // write at the route level would lock read-only tokens and anonymous public-repo
    // pulls out entirely. So the route-level requirement is `read`; `batch()` then
    // re-authorizes `write` in-handler when `operation === "upload"`.
    if (match?.entry.handlerId === "batch") {
      return { action: "read" };
    }
    const permission = readWritePermission(method);
    const oid = match?.params.oid;
    if (oid) return { ...permission, resource: { type: "artifact", artifactRef: oid } };
    return permission;
  }

  // ── batch ────────────────────────────────────────────────────────────────
  /** `POST /objects/batch` — negotiate `upload`/`download` actions per object. */
  async batch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      // A malformed/unparseable body is a validation error (422), consistent with
      // the schema-invalid case below and the Git LFS Batch API's 422 for validation.
      return lfsJson({ message: "request body is not valid JSON" }, 422);
    }
    const parsed = LfsBatchRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return lfsJson({ message: "invalid batch request" }, 422);
    }
    const { operation, objects } = parsed.data;

    // The route-level permission is `read` (so downloads/pulls work for read-only and
    // anonymous principals). An upload batch is the push path, so re-authorize `write`
    // here now that the body's operation is known.
    if (operation === "upload") {
      const decision = await ctx.authorize("write", { repositoryName: ctx.repo.name });
      if (!decision.allowed) {
        const status = decision.code === "unauthenticated" ? 401 : 403;
        return lfsJson(
          { message: decision.reason ?? "write permission is required to upload objects" },
          status,
        );
      }
    }

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
  async getObject(
    oidRaw: string,
    _req: Request,
    ctx: RegistryRequestContext,
    _headOnly: boolean,
  ): Promise<Response> {
    const oid = parseOid(oidRaw);
    if (oid instanceof Response) return oid;
    return serveRegistryBlob(ctx, {
      digest: oidToDigest(oid),
      kind: LFS_BLOB_KIND,
      scope: LFS_BLOB_SCOPE,
      contentType: "application/octet-stream",
      blocked: () => lfsJson({ message: "object blocked by scan policy" }, 403),
      missing: () => lfsJson({ message: "object does not exist" }, 404),
    });
  }

  /** `PUT /objects/:oid` — upload object content; the body's sha256 must equal `oid`. */
  async putObject(oidRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const oid = parseOid(oidRaw);
    if (oid instanceof Response) return oid;
    const digest = oidToDigest(oid);
    // Stream the body straight into the CAS rather than buffering it in memory:
    // LFS objects can be many gigabytes, so `expectedDigest` lets the store hash
    // and verify the bytes as they flow (content addressing is only sound if the
    // uploaded bytes hash to the claimed oid). A mismatch surfaces as
    // `InvalidDigestError`. We render it as an LFS-shaped `{message}` body (422
    // Validation error) with the `application/vnd.git-lfs+json` media type rather
    // than throwing a RegistryError that the framework would serialize in the
    // non-LFS `singleError` shape — the git-lfs client decodes error bodies into a
    // struct keyed on `message`, so the diagnostic must live there.
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
          scan: { mediaType: "application/octet-stream" },
        },
      });
    } catch (err) {
      if (err instanceof InvalidDigestError) {
        return lfsJson({ message: "uploaded content does not match the object id" }, 422);
      }
      throw err;
    }
    return new Response(null, { status: 200 });
  }

  // ── locks ──────────────────────────────────────────────────────────────────
  /**
   * The file-locking API (`POST /locks`, `GET /locks`, `POST /locks/verify`,
   * `POST /locks/:id/unlock`) is optional and not backed by storage here. Per the
   * Git LFS locking spec, "an LFS server that doesn't implement any locking endpoints
   * should return 404. This response will not halt any Git pushes." So every locking
   * verb presents one coherent posture: a 404 with the LFS-shaped `{message}` body.
   * This cleanly disables locking client-side (and `lfs.<url>.locksverify`) without
   * the contradictory mix of verify-200/create-501 that a partial implementation gives.
   */
  locksUnsupported(): Response {
    return lfsJson({ message: "locking is not supported by this registry" }, 404);
  }
}

const gitlfsDefinition = registryAdapter("gitlfs")
  .stateClass(GitLfsAdapterState)
  .module((module) =>
    module
      .displayName("Git LFS")
      .mount("lfs")
      // LFS objects are keyed by sha256 oid. The basic-transfer PUT is not resumable,
      // LFS has no upstream-mirror semantics, and it is a flat non-virtual store.
      .capabilities("contentAddressable")
      .errorResponseKind("singleError"),
  )
  .basicAuth()
  .fromState((state) => state.defaultPermission("requiredPermission"))
  .routes((route) => [
    // Literal/static routes declared before the `/objects/:oid` catch-all.
    route.post("/objects/batch", "batch").calls((state, { req, ctx }) => state.batch(req, ctx)),
    route.post("/locks/verify", "locksVerify").calls((state) => state.locksUnsupported()),
    route.post("/locks/:id/unlock", "locksUnlock").calls((state) => state.locksUnsupported()),
    route.post("/locks", "locksCreate").calls((state) => state.locksUnsupported()),
    route.get("/locks", "locksList").calls((state) => state.locksUnsupported()),
    route
      .head("/objects/:oid", "headObject")
      .calls((state, { params, req, ctx }) => state.getObject(params.oid, req, ctx, true)),
    route
      .immutableGet("/objects/:oid", "getObject")
      .calls((state, { params, req, ctx }) => state.getObject(params.oid, req, ctx, false)),
    route
      .put("/objects/:oid", "putObject")
      .calls((state, { params, req, ctx }) => state.putObject(params.oid, req, ctx)),
  ]);

export class GitLfsAdapter extends gitlfsDefinition.adapterClass() {}
export const gitlfsRegistryPlugin = createRegistryAdapterPlugin(GitLfsAdapter);
