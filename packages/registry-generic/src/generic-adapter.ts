import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { readBoundedStream } from "./generic-body";
import { handleGenericProxyIngest } from "./generic-proxy-lifecycle";
import { handleGenericStore } from "./generic-store-lifecycle";
import {
  buildGenericIndexEntries,
  GENERIC_VERSION,
  GenericPathSchema,
  GenericPrefixSchema,
  type GenericVersionMeta,
  genericBlobScope,
  parseGenericVersionMeta,
} from "./generic-validation";

function parsePath(path: string): string {
  return parseRegistryInput(GenericPathSchema, path, {
    code: "NAME_INVALID",
    message: "invalid generic path",
  });
}

function parsePrefix(prefix: string): string {
  // The index builder treats `docs` and `docs/` as the same directory, so accept
  // a single trailing slash from the query by normalizing it away before the
  // schema (which, like a stored path, forbids a trailing slash) validates it.
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return parseRegistryInput(GenericPrefixSchema, normalized, {
    code: "NAME_INVALID",
    message: "invalid generic prefix",
  });
}

const INDEX_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Generic / raw registry. An arbitrary path-addressed blob store: `PUT /<path>`
 * uploads a raw file at a repo-relative path (paths are mutable addresses, not
 * digests), `GET`/`HEAD /<path>` serve it back with checksum sidecar headers,
 * `DELETE /<path>` removes it, and `GET /` returns a directory listing (optionally
 * filtered by a `?prefix=` query). Proxyable (pull-through) and virtualizable.
 */
export class GenericAdapter implements RegistryPlugin {
  readonly id = "generic" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Generic",
      mountSegment: "generic",
      errorResponseKind: "singleError",
      compressibleHandlers: ["index"],
      scan: {
        defaultOsvEcosystem: undefined,
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .proxyIngest((name, upstreamBase, ctx) => this.proxyIngest(name, upstreamBase, ctx))
    .routes((route) => [
      // The bare-root listing is a literal route declared before the `:path+`
      // catch-alls so it cannot be shadowed (the matcher tries routes in order).
      route.get("/", "index", ({ req, ctx }) => this.index(req, ctx)),
      // `proxyRefreshTrigger` + `packageParam: "path"` opt this read into the
      // agnostic proxy dispatcher: on a read miss against a proxy repo it invokes
      // `proxyIngest(params.path, ...)` to mirror the blob from upstream, then
      // retries locally. The greedy param is named `path`, so the dispatcher needs
      // `packageParam` to know which match param carries the blob address.
      route.get(
        "/:path+",
        "download",
        ({ params, req, ctx }) => this.download(params.path, req, ctx),
        { proxyRefreshTrigger: true, packageParam: "path" },
      ),
      route.head("/:path+", "head", ({ params, req, ctx }) => this.download(params.path, req, ctx)),
      route.put("/:path+", "publish", ({ params, req, ctx }) =>
        this.publish(params.path, req, ctx),
      ),
      route.delete("/:path+", "remove", ({ params, ctx }) => this.remove(params.path, ctx)),
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
    const permission = readWritePermission(method);
    const raw = match?.params.path;
    if (!raw) return permission;
    // A read of a stored blob targets the artifact ref; writes/deletes too.
    return {
      ...permission,
      resource: {
        type: "artifact",
        packageName: raw,
        artifactRef: genericBlobScope(raw),
      },
    };
  }

  handle = this.delegate.handle;

  /**
   * `GET /` — list stored paths as JSON. An optional `?prefix=<dir>` query filters
   * to entries under that directory. The body is deterministically ordered so the
   * ETag is stable across requests.
   */
  private async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const prefix = parsePrefix(url.searchParams.get("prefix") ?? "");
    const metas = await this.listMetas(ctx);
    const entries = buildGenericIndexEntries(metas, prefix);
    return textResponseWithEtag(req, JSON.stringify({ prefix, entries }), {
      "content-type": INDEX_CONTENT_TYPE,
    });
  }

  /** `GET`/`HEAD /<path>` — serve the stored blob with checksum sidecar headers. */
  private async download(
    pathRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const path = parsePath(pathRaw);
    const pkg = await ctx.data.packages.findByName(path);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, GENERIC_VERSION);
    const meta = parseGenericVersionMeta(row?.metadata);
    if (!meta) throw Errors.notFound();
    const etag = `"${meta.sha256}"`;
    // Checksum sidecars. `x-checksum-md5` is omitted for legacy blobs stored
    // before md5 was tracked (meta.md5 absent), matching raw-store conventions.
    const extraHeaders: Record<string, string> = {
      etag,
      "x-checksum-sha256": meta.sha256,
      "x-checksum-sha512": meta.sha512,
    };
    if (meta.md5) extraHeaders["x-checksum-md5"] = meta.md5;
    // On a GET the blob is served as a raw ReadableStream, for which Bun strips an
    // explicit content-length and sends the body chunked, so the header would be a
    // no-op. A HEAD carries no body, so we surface the exact size there — letting a
    // client size the artifact (or pre-allocate) before issuing the GET.
    if (req.method === "HEAD") extraHeaders["content-length"] = String(meta.size);
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: "generic_blob",
      scope: genericBlobScope(path),
      contentType: meta.contentType,
      extraHeaders,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
      // Honor If-None-Match so a conditional GET/HEAD revalidating the advertised
      // ETag short-circuits to 304 instead of re-streaming the whole blob.
      notModified: () =>
        ifNoneMatch(req, etag) ? new Response(null, { status: 304, headers: { etag } }) : null,
    });
  }

  /** `PUT /<path>` — store a raw blob at the path (overwriting any existing blob). */
  private async publish(
    pathRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const path = parsePath(pathRaw);
    // Stream the body with a running byte count so an oversized upload is rejected
    // as soon as it crosses the limit, rather than being fully buffered first.
    const body = await readBoundedStream(req.body, ctx.limits.maxUploadBytes);
    if (!body) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
    const result = await handleGenericStore(path, body, req.headers.get("content-type"), ctx);
    return Response.json(
      {
        ok: true,
        path: result.path,
        size: result.meta.size,
        sha256: result.meta.sha256,
        sha512: result.meta.sha512,
      },
      { status: result.created ? 201 : 200 },
    );
  }

  /** `DELETE /<path>` — remove the stored blob, releasing its CAS ref. */
  private async remove(pathRaw: string, ctx: RegistryRequestContext): Promise<Response> {
    const path = parsePath(pathRaw);
    const pkg = await ctx.data.packages.findByName(path);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, GENERIC_VERSION);
    const meta = parseGenericVersionMeta(row?.metadata);
    if (!meta || !row) throw Errors.notFound();
    // Tombstone every version referencing the blob (so `findLive` stops resolving
    // the path) and release its CAS ref so retention can GC the bytes.
    await ctx.data.contentStore.markPackageVersionsDeletedByDigest({
      package: pkg,
      digest: meta.blobDigest,
    });
    await ctx.data.content.releaseBlobRef({
      digest: meta.blobDigest,
      kind: "generic_blob",
      scope: genericBlobScope(path),
    });
    return new Response(null, { status: 204 });
  }

  /** Pull-through: mirror a path from an upstream base URL into this proxy repo. */
  async proxyIngest(
    path: string,
    upstreamBase: string,
    ctx: RegistryRequestContext,
  ): Promise<boolean> {
    return handleGenericProxyIngest(path, upstreamBase, ctx);
  }

  /**
   * Every live path's stored metadata across the repo (for the index listing).
   * Batches the live-version lookup over all packages in one query instead of a
   * per-package `findLive`, so the index scales with repo size.
   */
  private async listMetas(ctx: RegistryRequestContext): Promise<GenericVersionMeta[]> {
    const pkgs = await ctx.data.packages.list();
    const liveByPackageId = await ctx.data.versions.listLiveForPackages(pkgs);
    const metas: GenericVersionMeta[] = [];
    for (const pkg of pkgs) {
      const live = liveByPackageId.get(pkg.id) ?? [];
      const row = live.find((r) => r.version === GENERIC_VERSION);
      const meta = parseGenericVersionMeta(row?.metadata);
      if (meta) metas.push(meta);
    }
    return metas;
  }
}

export const genericRegistryPlugin: RegistryPlugin = new GenericAdapter();
