import {
  Errors,
  ifNoneMatch,
  type RegistryPackageRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { buildPackagesIndex, type CranIndexEntry } from "./cran-index";
import { CRAN_TARBALL_KIND, cranBlobScope, handleCranPublish } from "./cran-publish-lifecycle";
import { parseCranTarballFilename, parseCranVersionMeta } from "./cran-validation";

const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" } as const;
const INDEX_TTL_MS = 5_000;

interface IndexCacheEntry {
  text: string;
  gz: Uint8Array;
  expiresAt: number;
}

/**
 * CRAN (R) source repository. Hosts source tarballs at `src/contrib/`, serving a
 * regenerated Debian-control-style `PACKAGES` index (and its `PACKAGES.gz`
 * variant) over the live versions. The optional `PACKAGES.rds` index is not
 * served; its route 404s explicitly so R's `.rds -> .gz -> plain` fallback stays
 * reliable. Publish is a hootifactory extension: clients `PUT` a
 * `<pkg>_<version>.tar.gz`, whose DESCRIPTION we parse for the index. Binary
 * paths under `/bin/...` 404 (no compiled binaries are hosted).
 */
class CranAdapterState {
  private readonly indexCache = new Map<string, IndexCacheEntry>();

  /** Build (or reuse a cached) `{ text, gz }` PACKAGES index for this repo. */
  private async index(ctx: RegistryRequestContext): Promise<IndexCacheEntry> {
    const key = ctx.repo.id;
    const cached = this.indexCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const names = await ctx.data.packages.listNames();
    const entries: CranIndexEntry[] = [];
    for (const { name } of names) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const meta = await this.latestMeta(ctx, pkg);
      if (meta) {
        entries.push({
          name: meta.name,
          version: meta.version,
          controlFields: meta.controlFields,
          md5: meta.md5,
        });
      }
    }
    const text = buildPackagesIndex(entries);
    const gz = Bun.gzipSync(new TextEncoder().encode(text));
    const entry: IndexCacheEntry = { text, gz, expiresAt: Date.now() + INDEX_TTL_MS };
    this.indexCache.set(key, entry);
    return entry;
  }

  /** `GET /src/contrib/PACKAGES[.gz]` — the regenerated control-stanza index. */
  async packages(gz: boolean, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const index = await this.index(ctx);
    if (!gz) return textResponseWithEtag(req, index.text, TEXT_PLAIN);
    const etag = `"${new Bun.CryptoHasher("md5").update(index.gz).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(index.gz, { headers: { "content-type": "application/gzip", etag } });
  }

  /** `GET /src/contrib/<pkg>_<version>.tar.gz` — serve the stored source tarball. */
  download(filenameRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const parts = parseCranTarballFilename(filenameRaw);
    if (!parts) throw Errors.notFound();
    return this.serveTarball(parts.name, parts.version, req, ctx);
  }

  /**
   * `GET /src/contrib/Archive/<pkg>/<pkg>_<version>.tar.gz` — serve a superseded
   * source tarball. R tooling (remotes::install_version, renv, pak) requests any
   * non-current release exclusively under this Archive layout, so it must resolve
   * the same stored blob the flat download route would. The `<pkg>` path segment
   * must agree with the filename's encoded package name.
   */
  archiveDownload(
    pkgSegment: string,
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const parts = parseCranTarballFilename(filenameRaw);
    if (!parts || parts.name !== pkgSegment) throw Errors.notFound();
    return this.serveTarball(parts.name, parts.version, req, ctx);
  }

  /** Resolve any live version of `name` and stream its stored source tarball. */
  private async serveTarball(
    name: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, version);
    const meta = parseCranVersionMeta(row?.metadata);
    if (!meta) throw Errors.notFound();
    const scope = cranBlobScope(name, version);
    return serveRegistryBlob(ctx, {
      digest: meta.blobDigest,
      kind: CRAN_TARBALL_KIND,
      scope,
      contentType: "application/gzip",
      redirect: req.method === "GET",
      blocked: () => new Response("package blocked by scan policy", { status: 403 }),
    });
  }

  async publish(filenameRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const parts = parseCranTarballFilename(filenameRaw);
    if (!parts) throw Errors.nameInvalid("invalid CRAN tarball filename");
    const res = await handleCranPublish(parts, req, ctx);
    if (res.status >= 200 && res.status < 300) this.indexCache.delete(ctx.repo.id);
    return res;
  }

  /** Latest live version's stored CRAN metadata (versions ordered by creation). */
  private async latestMeta(ctx: RegistryRequestContext, pkg: RegistryPackageRow) {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    for (const row of rows) {
      const meta = parseCranVersionMeta(row.metadata);
      if (meta) return meta;
    }
    return null;
  }
}

function cranDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const deps = metadata.deps;
  if (!Array.isArray(deps)) return {};
  const out: Record<string, string> = {};
  for (const name of deps) {
    if (typeof name === "string") out[name] = "";
  }
  return out;
}

const cranDefinition = registryAdapter("cran")
  .stateClass(CranAdapterState)
  .module((module) =>
    module
      .displayName("CRAN")
      .mount("cran")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("packages"),
  )
  .scan({
    defaultOsvEcosystem: "CRAN",
    dependencyGraph: ({ metadata }) => ({
      deps: cranDependencyGraph(metadata),
      osvEcosystem: "CRAN",
      purlType: "cran",
    }),
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "filename",
        normalize: (filename) => {
          const parts = parseCranTarballFilename(filename);
          return parts ? cranBlobScope(parts.name, parts.version) : null;
        },
        packageName: ({ params }) =>
          params.filename ? parseCranTarballFilename(params.filename)?.name : undefined,
      }),
    ]),
  )
  .routes((route) => [
    // Literal index routes are declared before the `/:filename` catch-all so
    // they cannot be shadowed (the matcher tries routes in order).
    route
      .get("/src/contrib/PACKAGES", "packages")
      .calls((state, { req, ctx }) => state.packages(false, req, ctx)),
    route
      .get("/src/contrib/PACKAGES.gz", "packagesGz")
      .calls((state, { req, ctx }) => state.packages(true, req, ctx)),
    // R's available.packages()/install.packages() probes PACKAGES.rds FIRST
    // (preferred over PACKAGES.gz/PACKAGES). This server serves no RDS index,
    // so the route is registered explicitly to return a deterministic 404.
    route.get("/src/contrib/PACKAGES.rds", "packagesRds").handle(() => {
      throw Errors.notFound();
    }),
    // Superseded versions are fetched by R tooling only under `Archive/<pkg>/`.
    // Declared before the `/src/contrib/:filename` catch-all.
    route
      .get("/src/contrib/Archive/:pkg/:filename", "archiveDownload")
      .calls((state, { params, req, ctx }) =>
        state.archiveDownload(params.pkg, params.filename, req, ctx),
      ),
    route
      .get("/src/contrib/:filename", "download")
      .calls((state, { params, req, ctx }) => state.download(params.filename, req, ctx)),
    route
      .put("/src/contrib/:filename", "publish")
      .calls((state, { params, req, ctx }) => state.publish(params.filename, req, ctx)),
    // Binary packages are not hosted; any /bin/... path 404s.
    route.get("/bin/:path+", "binary").handle(() => {
      throw Errors.notFound();
    }),
  ]);

export class CranAdapter extends cranDefinition.adapterClass() {}
export const cranRegistryPlugin: RegistryPlugin = new CranAdapter();
