import {
  bytesResponseWithEtag,
  createRegistryAdapterPlugin,
  Errors,
  type RegistryPackageHandle,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
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

const repoParam: RegistryRouteParamSpec = {
  schema: ArchRepoSchema,
  code: "NAME_INVALID",
  message: "invalid repository",
};

const archParam: RegistryRouteParamSpec = {
  schema: ArchArchSchema,
  code: "NAME_INVALID",
  message: "invalid arch",
};

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
class ArchAdapterState {
  /**
   * Collect sync-DB entries. When `arch` is given entries are filtered to the
   * requested architecture (including `any`) and the dedup is keyed by
   * `(pkgname, arch)` — folding `any` into the requested arch so that a
   * `any`-arch package replaces its arch-specific counterpart when it has a
   * higher version. Without `arch` a single latest entry per package name is
   * returned across all architectures (used by the AUR search RPC).
   */
  private async collectEntries(ctx: RegistryRequestContext, arch?: string): Promise<ArchDbEntry[]> {
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
        if (arch !== undefined && meta.arch !== arch && meta.arch !== "any") continue;
        const key =
          arch !== undefined
            ? `${meta.pkgname}:${meta.arch === "any" ? arch : meta.arch}`
            : meta.pkgname;
        const current = latestByName.get(key);
        if (!current || archVercmp(meta.pkgver, current.pkgver) > 0) {
          latestByName.set(key, meta);
        }
      }
    }
    return [...latestByName.values()];
  }

  /** `GET /<repo>/os/<arch>/<file>` — sync DB, or a package blob, by extension. */
  async fetch(
    repo: string,
    arch: string,
    file: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    if (dbFileNames(repo).has(file)) {
      return this.serveDb(arch, req, ctx);
    }
    if (isArchPkgFile(file)) {
      return this.download(file, req, ctx);
    }
    throw Errors.notFound();
  }

  /** Serve the regenerated sync DB (gzip'd tar) with a content-stable ETag. */
  private async serveDb(
    arch: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const db = buildArchDb(await this.collectEntries(ctx, arch));
    return bytesResponseWithEtag(req, db.gz, DB_GZIP);
  }

  /** Serve a package blob, resolved from the stored asset by filename scope. */
  private async download(
    file: string,
    _req: Request,
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
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  async publish(file: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleArchPublish(file, req, ctx);
  }

  /**
   * AUR-style RPC:
   *   `GET /rpc/?v=5&type=info&arg[]=<name>` resolves exact names;
   *   `GET /rpc/?v=5&type=search&arg=<keyword>&by=name[-desc]` discovers
   *   packages by substring (the query yay/paru issue before resolving versions).
   */
  async rpc(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

const archDefinition = registryAdapter("arch")
  .stateClass(ArchAdapterState)
  .module((module) =>
    module
      .displayName("Arch")
      .mount("arch")
      // Only `virtualizable` is honest: generic virtual fan-out works without
      // adapter-specific machinery, while proxy creation requires proxyIngest.
      .capabilities("virtualizable")
      .errorResponseKind("singleError"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    dependencyGraph: ({ metadata }) => ({
      deps: archDependencyGraph(metadata),
      purlType: "alpm",
    }),
    referencedDigests: (metadata) =>
      typeof metadata.blobDigest === "string" ? [metadata.blobDigest] : [],
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "file",
        normalize: (file, { params }) =>
          params.repo && isValidArchRepo(params.repo) && isArchPkgFile(file) ? file : null,
      }),
    ]),
  )
  .routes((route) => [
    // `/rpc/` is a literal prefix declared before the `/:repo/...` catch-alls
    // (the route-matcher tries routes in declared order).
    route.get("/rpc/", "rpc").calls((state, { req, ctx }) => state.rpc(req, ctx)),
    route.get("/rpc", "rpc").calls((state, { req, ctx }) => state.rpc(req, ctx)),
    route
      .get("/:repo/os/:arch/:file", "fetch")
      .params({ repo: repoParam, arch: archParam })
      .calls((state, { params, req, ctx }) =>
        state.fetch(params.repo, params.arch, params.file, req, ctx),
      ),
    route
      .put("/:repo/os/:arch/:file", "publish")
      .params({ repo: repoParam, arch: archParam })
      .calls((state, { params, req, ctx }) => state.publish(params.file, req, ctx)),
  ]);

export class ArchAdapter extends archDefinition.adapterClass() {}
export const archRegistryPlugin = createRegistryAdapterPlugin(ArchAdapter);
