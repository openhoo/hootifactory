import {
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  parseRegistryInput,
  type RegistryMetadata,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { handleCondaProxyIngest } from "./conda-proxy";
import {
  CONDA_MEDIA_TYPE,
  CONDA_PACKAGE_KIND,
  condaBlobScope,
  condaVersionKey,
  handleCondaPublish,
} from "./conda-publish-lifecycle";
import {
  buildCondaRepodata,
  type CondaRepodataDocument,
  mergeCondaRepodata,
  serializeCondaRepodata,
} from "./conda-repodata";
import {
  CondaFilenameSchema,
  CondaSubdirSchema,
  type CondaVersionMeta,
  condaPackageKind,
  isValidCondaSubdir,
  parseCondaFilename,
  parseCondaVersionMeta,
} from "./conda-validation";

const REPODATA_CONTENT_TYPE = { "content-type": "application/json; charset=utf-8" } as const;

function parseSubdir(subdir: string): string {
  return parseRegistryInput(CondaSubdirSchema, subdir, {
    code: "NAME_INVALID",
    message: "invalid Conda subdir",
  });
}

/**
 * Conda channel. Clients add a repo's mount URL as a channel and fetch
 * `<subdir>/repodata.json` indexes plus `<subdir>/<filename>` package blobs.
 * Publish is a hootifactory extension: real channels are uploaded via
 * `anaconda upload`; we accept a `PUT /<subdir>/<filename>` of the package's
 * `index.json` metadata + the blob and host it ourselves, regenerating the
 * subdir's `repodata.json` from the live versions.
 */
class CondaAdapterState {
  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const subdir = match?.params.subdir;
    const filename = match?.params.filename;
    if (subdir && filename && isValidCondaSubdir(subdir)) {
      return {
        ...permission,
        resource: { type: "artifact", artifactRef: condaBlobScope(subdir, filename) },
      };
    }
    return permission;
  }

  /** Collect a subdir's live version metadata across the repo's packages. */
  private async subdirMetas(
    ctx: RegistryRequestContext,
    subdir: string,
  ): Promise<CondaVersionMeta[]> {
    const names = await ctx.data.packages.listNames();
    const metas: CondaVersionMeta[] = [];
    for (const { name } of names) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      for (const row of await ctx.data.versions.listLive(pkg)) {
        const meta = parseCondaVersionMeta(row.metadata);
        if (meta && meta.subdir === subdir) metas.push(meta);
      }
    }
    return metas;
  }

  private async buildSubdirRepodata(
    ctx: RegistryRequestContext,
    subdir: string,
  ): Promise<CondaRepodataDocument> {
    return buildCondaRepodata(subdir, await this.subdirMetas(ctx, subdir));
  }

  /** `GET /<subdir>/repodata.json` — the channel index for one subdir. */
  async repodata(subdirRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const subdir = parseSubdir(subdirRaw);
    const doc = await this.buildSubdirRepodata(ctx, subdir);
    return textResponseWithEtag(req, serializeCondaRepodata(doc), REPODATA_CONTENT_TYPE);
  }

  /**
   * `GET /<subdir>/repodata.json.zst` — a zstd-compressed repodata variant.
   * Modern conda/mamba clients fetch the compressed index by name and decode it
   * by its suffix, so the bytes must be real zstd (`application/zstd`), not gzip.
   */
  async repodataCompressed(
    subdirRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const subdir = parseSubdir(subdirRaw);
    const doc = await this.buildSubdirRepodata(ctx, subdir);
    const body = new TextEncoder().encode(serializeCondaRepodata(doc));
    const compressed = Bun.zstdCompressSync(body);
    const etag = `"${new Bun.CryptoHasher("md5").update(compressed).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(compressed, { headers: { "content-type": "application/zstd", etag } });
  }

  /** `GET /<subdir>/<filename>` — serve the hosted package blob. */
  async download(
    subdirRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const subdir = parseSubdir(subdirRaw);
    // A download path that is not a `.conda`/`.tar.bz2` package filename is a
    // miss, not a malformed request: stock conda probes index variants conda
    // does not serve here — `current_repodata.json`, `current_repodata.json.zst`,
    // `repodata.json.bz2` — through this same `/:subdir/:filename` route, then
    // falls back to `repodata.json` ONLY on a 404. Returning 400 (NAME_INVALID)
    // would surface as a hard CondaHTTPError and abort the install before the
    // working `repodata.json` is ever requested, so answer these with 404.
    if (!CondaFilenameSchema.safeParse(filenameRaw).success) {
      return new Response("Not Found", { status: 404 });
    }
    const filename = parseRegistryInput(CondaFilenameSchema, filenameRaw, {
      code: "NAME_INVALID",
      message: "invalid package filename",
    });
    const meta = await this.findPackageMeta(ctx, subdir, filename);
    if (!meta) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: CONDA_PACKAGE_KIND,
      scope: condaBlobScope(subdir, filename),
      contentType: CONDA_MEDIA_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /**
   * Resolve the stored version metadata for a `<subdir>/<filename>` pair. The
   * filename encodes `<name>-<version>-<build>` and the extension selects the
   * package kind, so we can resolve the package + version row directly instead
   * of scanning every package in the repo.
   */
  private async findPackageMeta(
    ctx: RegistryRequestContext,
    subdir: string,
    filename: string,
  ): Promise<CondaVersionMeta | null> {
    const coords = parseCondaFilename(filename);
    const kind = condaPackageKind(filename);
    if (!coords || !kind) return null;
    const pkg = await ctx.data.packages.findByName(coords.name);
    if (!pkg) return null;
    const versionKey = condaVersionKey(coords.version, coords.build, kind);
    const row = await ctx.data.versions.findLive(pkg, versionKey);
    const meta = row ? parseCondaVersionMeta(row.metadata) : null;
    // Guard against a metadata/path mismatch: the stored record must point at
    // exactly this subdir + filename.
    if (!meta || meta.subdir !== subdir || meta.filename !== filename) return null;
    return meta;
  }

  async publish(
    subdirRaw: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const subdir = parseSubdir(subdirRaw);
    // The permission check (and audit scope) is performed against the URL
    // `:subdir/:filename`; the publish must store exactly that path, never the
    // filename the uploaded part happens to carry.
    const filename = parseRegistryInput(CondaFilenameSchema, filenameRaw, {
      code: "NAME_INVALID",
      message: "invalid package filename",
    });
    return handleCondaPublish(subdir, filename, req, ctx);
  }

  proxyIngest(name: string, upstreamBase: string, ctx: RegistryRequestContext): Promise<boolean> {
    return handleCondaProxyIngest(name, upstreamBase, ctx);
  }

  /**
   * Virtual aggregation: each member generates its subdir's `repodata.json`; the
   * runtime then calls `mergeMetadata` to fold them into one document. The
   * mergeable route's `packageParam` carries the subdir, so `name` is the subdir.
   */
  async generateMetadata(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<RegistryMetadata | null> {
    if (!isValidCondaSubdir(name)) return null;
    const doc = await this.buildSubdirRepodata(ctx, name);
    return {
      contentType: "application/json; charset=utf-8",
      body: serializeCondaRepodata(doc),
    };
  }

  async mergeMetadata(
    parts: RegistryMetadata[],
    _ctx: RegistryRequestContext,
  ): Promise<RegistryMetadata> {
    const docs: CondaRepodataDocument[] = [];
    let subdir = "noarch";
    for (const part of parts) {
      const text = typeof part.body === "string" ? part.body : new TextDecoder().decode(part.body);
      try {
        const doc = JSON.parse(text) as CondaRepodataDocument;
        if (doc?.info?.subdir) subdir = doc.info.subdir;
        docs.push(normalizeDoc(doc));
      } catch {
        // Skip unparseable member documents.
      }
    }
    return {
      contentType: "application/json; charset=utf-8",
      body: serializeCondaRepodata(mergeCondaRepodata(subdir, docs)),
    };
  }
}

function normalizeDoc(doc: CondaRepodataDocument): CondaRepodataDocument {
  return {
    info: { subdir: doc?.info?.subdir ?? "noarch" },
    packages: doc?.packages ?? {},
    "packages.conda": doc?.["packages.conda"] ?? {},
    repodata_version: doc?.repodata_version ?? 1,
    removed: doc?.removed ?? [],
  };
}

const condaDefinition = registryAdapter("conda")
  .stateClass(CondaAdapterState)
  .module((module) =>
    module
      .displayName("Conda")
      .mount("conda")
      .capabilities("proxyable", "virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("repodata"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .fromState((state) =>
    state
      .defaultPermission("requiredPermission")
      .metadata({ generate: "generateMetadata", merge: "mergeMetadata" })
      .proxyIngest("proxyIngest"),
  )
  .routes((route) => [
    // Literal index routes declared before the `/:subdir/:filename` catch-all.
    route
      .get("/:subdir/repodata.json", "repodata")
      .metadata("subdir", { proxyRefresh: true })
      .calls((state, { params, req, ctx }) => state.repodata(params.subdir, req, ctx)),
    // Modern conda/mamba fetch the `.zst` index FIRST and only fall back to
    // plain `repodata.json` on a non-200. It refreshes proxy state but is not
    // marked mergeable because virtual metadata returns plain JSON text.
    route
      .get("/:subdir/repodata.json.zst", "repodataZst")
      .proxyRefresh("subdir")
      .calls((state, { params, req, ctx }) => state.repodataCompressed(params.subdir, req, ctx)),
    route
      .get("/:subdir/:filename", "download")
      .calls((state, { params, req, ctx }) =>
        state.download(params.subdir, params.filename, req, ctx),
      ),
    route
      .put("/:subdir/:filename", "publish")
      .calls((state, { params, req, ctx }) =>
        state.publish(params.subdir, params.filename, req, ctx),
      ),
  ]);

export class CondaAdapter extends condaDefinition.adapterClass() {}
export const condaRegistryPlugin: RegistryPlugin = new CondaAdapter();
