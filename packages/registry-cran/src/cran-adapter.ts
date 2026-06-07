import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  type RegistryPackageRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
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
 * variant) over the live versions. Publish is a hootifactory extension: clients
 * `PUT` a `<pkg>_<version>.tar.gz`, whose DESCRIPTION we parse for the index.
 * Binary paths under `/bin/...` 404 (no compiled binaries are hosted).
 */
export class CranAdapter implements RegistryPlugin {
  readonly id = "cran" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;
  private readonly indexCache = new Map<string, IndexCacheEntry>();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "CRAN",
      mountSegment: "cran",
      errorResponseKind: "singleError",
      compressibleHandlers: ["packages"],
      scan: {
        defaultOsvEcosystem: "CRAN",
        dependencyGraph: ({ metadata }) => ({
          deps: cranDependencyGraph(metadata),
          osvEcosystem: "CRAN",
          purlType: "cran",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // Literal index routes are declared before the `/:filename` catch-all so
      // they cannot be shadowed (the matcher tries routes in order).
      route.get("/src/contrib/PACKAGES", "packages", ({ req, ctx }) =>
        this.packages(false, req, ctx),
      ),
      route.get("/src/contrib/PACKAGES.gz", "packagesGz", ({ req, ctx }) =>
        this.packages(true, req, ctx),
      ),
      // Superseded versions are fetched by R tooling (remotes::install_version,
      // renv, pak) only under `Archive/<pkg>/`. Declared before the
      // `/src/contrib/:filename` catch-all so the literal `Archive` segment wins.
      route.get("/src/contrib/Archive/:pkg/:filename", "archiveDownload", ({ params, req, ctx }) =>
        this.archiveDownload(params.pkg, params.filename, req, ctx),
      ),
      route.get("/src/contrib/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.filename, req, ctx),
      ),
      route.put("/src/contrib/:filename", "publish", ({ params, req, ctx }) =>
        this.publish(params.filename, req, ctx),
      ),
      // Binary packages are not hosted; any /bin/... path 404s.
      route.get("/bin/:path+", "binary", () => {
        throw Errors.notFound();
      }),
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
    const filename = match?.params.filename;
    const handlerId = match?.entry?.handlerId;
    if (
      filename &&
      (handlerId === "download" || handlerId === "publish" || handlerId === "archiveDownload")
    ) {
      const parts = parseCranTarballFilename(filename);
      if (parts) {
        return {
          ...permission,
          resource: {
            type: "artifact",
            packageName: parts.name,
            artifactRef: cranBlobScope(parts.name, parts.version),
          },
        };
      }
    }
    return permission;
  }

  handle = this.delegate.handle;

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
  private async packages(
    gz: boolean,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const index = await this.index(ctx);
    if (!gz) return textResponseWithEtag(req, index.text, TEXT_PLAIN);
    const etag = `"${new Bun.CryptoHasher("md5").update(index.gz).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(index.gz, { headers: { "content-type": "application/gzip", etag } });
  }

  /** `GET /src/contrib/<pkg>_<version>.tar.gz` — serve the stored source tarball. */
  private download(
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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
  private archiveDownload(
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

  private async publish(
    filenameRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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

export const cranRegistryPlugin: RegistryPlugin = new CranAdapter();
