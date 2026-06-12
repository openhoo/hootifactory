import {
  createRegistryAdapterPlugin,
  Errors,
  jsonResponseWithEtag,
  parseRegistryInput,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  serveRegistryBlob,
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

const pathParam: RegistryRouteParamSpec = {
  schema: GenericPathSchema,
  code: "NAME_INVALID",
  message: "invalid generic path",
};

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
class GenericAdapterState {
  /**
   * `GET /` — list stored paths as JSON. An optional `?prefix=<dir>` query filters
   * to entries under that directory. The body is deterministically ordered so the
   * ETag is stable across requests.
   */
  async index(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const prefix = parsePrefix(url.searchParams.get("prefix") ?? "");
    const metas = await this.listMetas(ctx);
    const entries = buildGenericIndexEntries(metas, prefix);
    return jsonResponseWithEtag(
      req,
      { prefix, entries },
      {
        "content-type": INDEX_CONTENT_TYPE,
      },
    );
  }

  /** `GET`/`HEAD /<path>` — serve the stored blob with checksum sidecar headers. */
  async download(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(path);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, GENERIC_VERSION);
    const meta = parseGenericVersionMeta(row?.metadata);
    if (!meta) throw Errors.notFound();
    const etag = `"${meta.sha256}"`;
    // Checksum sidecars. `x-checksum-md5` is omitted for legacy blobs stored
    // before md5 was tracked (meta.md5 absent), matching raw-store conventions.
    const extraHeaders: Record<string, string> = {
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
      req,
      etag,
    });
  }

  /** `PUT /<path>` — store a raw blob at the path (overwriting any existing blob). */
  async publish(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async remove(path: string, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(path);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, GENERIC_VERSION);
    const meta = parseGenericVersionMeta(row?.metadata);
    if (!meta || !row) throw Errors.notFound();
    // Tombstone every version referencing the blob (so `findLive` stops resolving
    // the path) and release its CAS ref so retention can GC the bytes.
    await ctx.data.versions.markPackageVersionsDeletedByDigest({
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

const genericDefinition = registryAdapter("generic")
  .stateClass(GenericAdapterState)
  .module((module) =>
    module
      .displayName("Generic")
      .mount("generic")
      .capabilities("proxyable", "virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("index"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .fromState((state) => state.proxyIngest("proxyIngest"))
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "path",
        packageName: ({ params }) => params.path,
        artifactRef: (path) => genericBlobScope(path),
      }),
    ]),
  )
  .routes((route) => [
    // The bare-root listing is declared before the `:path+` catch-alls.
    route.get("/", "index").calls((state, { req, ctx }) => state.index(req, ctx)),
    // On a proxy repo, a read miss mirrors the upstream blob by `params.path`.
    route
      .get("/:path+", "download")
      .params({ path: pathParam })
      .proxyRefresh("path")
      .calls((state, { params, req, ctx }) => state.download(params.path, req, ctx)),
    route
      .head("/:path+", "head")
      .params({ path: pathParam })
      .calls((state, { params, req, ctx }) => state.download(params.path, req, ctx)),
    route
      .put("/:path+", "publish")
      .params({ path: pathParam })
      .calls((state, { params, req, ctx }) => state.publish(params.path, req, ctx)),
    route
      .delete("/:path+", "remove")
      .params({ path: pathParam })
      .calls((state, { params, ctx }) => state.remove(params.path, ctx)),
  ]);

export class GenericAdapter extends genericDefinition.adapterClass() {}
export const genericRegistryPlugin = createRegistryAdapterPlugin(GenericAdapter);
