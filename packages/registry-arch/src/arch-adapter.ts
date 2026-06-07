import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { type ArchDbEntry, buildArchDb } from "./arch-db";
import { ARCH_PKG_KIND, archBlobScope, handleArchPublish } from "./arch-publish-lifecycle";
import {
  ArchArchSchema,
  ArchRepoSchema,
  type ArchVersionMeta,
  isArchPkgFile,
  isValidArchPkgName,
  isValidArchRepo,
  parseArchVersionMeta,
} from "./arch-validation";
import { archVercmp } from "./arch-vercmp";
import { aurRequestedNames, aurSearchTerm, buildAurResponse, matchesAurSearch } from "./aur-rpc";

const DB_GZIP = { "content-type": "application/gzip" } as const;
const PKG_CONTENT_TYPE = "application/octet-stream";

function parseRepo(repo: string): string {
  return parseRegistryInput(ArchRepoSchema, repo, {
    code: "NAME_INVALID",
    message: "invalid repository",
  });
}

function parseArch(arch: string): string {
  return parseRegistryInput(ArchArchSchema, arch, {
    code: "NAME_INVALID",
    message: "invalid arch",
  });
}

/**
 * Whether a `:file` segment names the sync DB (`<repo>.db` / `<repo>.db.tar.gz`).
 *
 * The `<repo>.files` database is deliberately NOT served: it is a DISTINCT
 * pacman artifact (a tar of `<pkgname>-<pkgver>/files` members carrying a
 * `%FILES%` manifest, consumed by `pacman -F`/`-Fy`). We do not capture the
 * per-package file manifest at publish time, so we cannot produce a correct
 * files DB. Aliasing it to the desc-only `.db` would make `pacman -F` silently
 * ingest wrong data; instead such requests fall through to a 404 (honest
 * "no files database" rather than a misleading one), mirroring how the apt
 * adapter 404s the endpoints it does not implement.
 */
function dbFileNames(repo: string): Set<string> {
  return new Set([`${repo}.db`, `${repo}.db.tar.gz`]);
}

/**
 * Arch Linux / pacman repository. Serves a deterministic sync database
 * (`<repo>.db` and `<repo>.db.tar.gz`) regenerated from the live package
 * versions, serves the `.pkg.tar.{zst,xz}` package blobs, accepts publish via
 * `PUT` of a package, and exposes an AUR-style `GET /rpc/?type=info` endpoint.
 */
export class ArchAdapter implements RegistryPlugin {
  readonly id = "arch" as const;
  // Only `virtualizable` is honest: the platform's generic fan-out virtual
  // dispatch works without per-adapter machinery (as apt/maven rely on). We do
  // NOT declare `proxyable` because proxy-repo creation is gated on
  // `adapter.proxyIngest`, which this adapter does not implement — advertising
  // it would let an operator pick "proxy" only to be rejected at create time.
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Arch",
      mountSegment: "arch",
      errorResponseKind: "singleError",
      compressibleHandlers: [],
      scan: {
        defaultOsvEcosystem: undefined,
        dependencyGraph: ({ metadata }) => ({
          deps: archDependencyGraph(metadata),
          purlType: "alpm",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      // `/rpc/` is a literal prefix declared before the `/:repo/...` catch-alls
      // (the route-matcher tries routes in declared order).
      route.get("/rpc/", "rpc", ({ req, ctx }) => this.rpc(req, ctx)),
      route.get("/rpc", "rpc", ({ req, ctx }) => this.rpc(req, ctx)),
      route.get("/:repo/os/:arch/:file", "fetch", ({ params, req, ctx }) =>
        this.fetch(params.repo, params.arch, params.file, req, ctx),
      ),
      route.put("/:repo/os/:arch/:file", "publish", ({ params, req, ctx }) =>
        this.publish(params.repo, params.arch, params.file, req, ctx),
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
    const permission = readWritePermission(method);
    const file = match?.params.file;
    const repo = match?.params.repo;
    if (file && repo && isValidArchRepo(repo) && isArchPkgFile(file)) {
      return { ...permission, resource: { type: "artifact", artifactRef: file } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  /**
   * Collect the CANONICAL sync-DB entries: exactly one per package name — the
   * highest version under pacman `vercmp` ordering. A real pacman sync DB (as
   * produced by `repo-add`) holds a single desc per name; libalpm keys its sync
   * cache by name, so emitting multiple same-NAME entries makes the installed
   * version non-deterministic. We still serve every published `.pkg` blob; only
   * the DB is narrowed to the latest per name.
   */
  private async collectEntries(ctx: RegistryRequestContext): Promise<ArchDbEntry[]> {
    const pkgs: RegistryPackageHandle[] = await ctx.data.packages.list();
    if (pkgs.length === 0) return [];
    const byPackage = await ctx.data.versions.listLiveForPackages(pkgs, {
      orderByCreated: "asc",
    });
    const latestByName = new Map<string, ArchVersionMeta>();
    for (const rows of byPackage.values()) {
      for (const row of rows) {
        const meta = parseArchVersionMeta(row.metadata);
        if (!meta) continue;
        const current = latestByName.get(meta.pkgname);
        if (!current || archVercmp(meta.pkgver, current.pkgver) > 0) {
          latestByName.set(meta.pkgname, meta);
        }
      }
    }
    return [...latestByName.values()];
  }

  /** `GET /<repo>/os/<arch>/<file>` — sync DB, or a package blob, by extension. */
  private async fetch(
    repoRaw: string,
    archRaw: string,
    fileRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const repo = parseRepo(repoRaw);
    parseArch(archRaw);
    if (dbFileNames(repo).has(fileRaw)) {
      return this.serveDb(req, ctx);
    }
    if (isArchPkgFile(fileRaw)) {
      return this.download(fileRaw, req, ctx);
    }
    throw Errors.notFound();
  }

  /** Serve the regenerated sync DB (gzip'd tar) with a content-stable ETag. */
  private async serveDb(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const db = buildArchDb(await this.collectEntries(ctx));
    const etag = `"${new Bun.CryptoHasher("sha256").update(db.gz).digest("hex")}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(db.gz, { headers: { ...DB_GZIP, etag } });
  }

  /** Serve a package blob, resolved from the stored asset by filename scope. */
  private async download(
    file: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const scope = archBlobScope(file);
    const asset = await ctx.data.assets.findByScope({ role: ARCH_PKG_KIND, scope });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: ARCH_PKG_KIND,
      scope,
      contentType: PKG_CONTENT_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async publish(
    repoRaw: string,
    archRaw: string,
    fileRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    parseRepo(repoRaw);
    parseArch(archRaw);
    return handleArchPublish(fileRaw, req, ctx);
  }

  /**
   * AUR-style RPC:
   *   `GET /rpc/?v=5&type=info&arg[]=<name>` resolves exact names;
   *   `GET /rpc/?v=5&type=search&arg=<keyword>&by=name[-desc]` discovers
   *   packages by substring (the query yay/paru issue before resolving versions).
   */
  private async rpc(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const url = new URL(req.url);
    const type = url.searchParams.get("type") ?? "info";
    if (type === "search") {
      return Response.json(buildAurResponse(type, await this.rpcSearch(url, ctx)));
    }
    if (type !== "info" && type !== "multiinfo") {
      return Response.json({ version: 5, type, resultcount: 0, results: [] });
    }
    const names = aurRequestedNames(url);
    const metas: ArchVersionMeta[] = [];
    for (const name of names) {
      // Guard the lookup key against a malformed package name before hitting data.
      if (!isValidArchPkgName(name)) continue;
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const meta = await this.latestMeta(ctx, pkg);
      if (meta) metas.push(meta);
    }
    return Response.json(buildAurResponse(type, metas));
  }

  /** Latest live version's stored metadata for a package (newest first). */
  private async latestMeta(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
  ): Promise<ArchVersionMeta | null> {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    for (const row of rows) {
      const meta = parseArchVersionMeta(row.metadata);
      if (meta) return meta;
    }
    return null;
  }

  /**
   * `type=search` over the hosted packages' canonical (latest) metadata. An
   * empty term yields no results rather than the whole repo. We reuse the same
   * deduped latest-per-name set the sync DB exposes, so search results agree
   * with what `pacman -Sy` would install.
   */
  private async rpcSearch(url: URL, ctx: RegistryRequestContext): Promise<ArchVersionMeta[]> {
    const term = aurSearchTerm(url);
    if (term === null) return [];
    const by = url.searchParams.get("by") ?? "name-desc";
    const entries = await this.collectEntries(ctx);
    return entries.filter((meta) => matchesAurSearch(meta, term, by));
  }
}

function archDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const depends = metadata.depends;
  if (!Array.isArray(depends)) return {};
  const out: Record<string, string> = {};
  for (const dep of depends) {
    if (typeof dep !== "string") continue;
    // A `depend` may carry a version constraint (`bar>=1.0`); split the bare name.
    const name = dep.split(/[<>=]/, 1)[0]?.trim();
    if (name) out[name] = "";
  }
  return out;
}

export const archRegistryPlugin: RegistryPlugin = new ArchAdapter();
