import {
  asJsonRecord,
  createRegistryAdapterPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryMetadata,
  type RegistryPackageHandle,
  type RegistryPackageVersionRow,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  type RegistryVirtualSearchInput,
  type RouteMatch,
  registryAdapter,
  repoResponseCache,
  type SearchQuery,
  type SearchResult,
  serveRegistryBlob,
  textEtag,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { parseNpmDistTag, parseNpmDistTagRequestBody } from "./npm-dist-tags";
import type { NpmDist } from "./npm-integrity";
import { handleNpmProxyIngest } from "./npm-proxy-lifecycle";
import { handleNpmPublish } from "./npm-publish-lifecycle";
import {
  buildNpmSearchObject,
  buildNpmSearchResponse,
  type NpmSearchObject,
  parseNpmSearchQuery,
} from "./npm-search";
import {
  NpmLegacyPackageNameSchema,
  NpmTarballFilenameSchema,
  parseNpmStoredVersionMetadata,
  versionFromTarballFilename,
} from "./npm-validation";
import {
  allNpmSearchResultsRequest,
  mergeNpmSearchBodies,
  npmSearchWindow,
  parseNpmSearchBody,
} from "./npm-virtual-search";
import { buildPackument, mergePackuments } from "./packument";

function parseNpmName(name: string): string {
  return parseRegistryInput(NpmLegacyPackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid package name",
  });
}

const tarballFilenameParam: RegistryRouteParamSpec = {
  schema: NpmTarballFilenameSchema,
  code: "NAME_INVALID",
  message: "invalid tarball filename",
};

const PACKUMENT_CONTENT_TYPE = "application/json; charset=utf-8";
const PACKUMENT_CACHE_MAX_ENTRIES = 512;
const COMPRESSIBLE_HANDLERS = ["packument", "search", "distTagsList"];

interface CachedPackument {
  token: string;
  text: string;
}

class NpmAdapterState {
  readonly packumentCache = repoResponseCache<CachedPackument>({
    maxEntries: PACKUMENT_CACHE_MAX_ENTRIES,
  });

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    return this.requiredRoutePermission(method, match);
  }

  requiredRoutePermission(method: HttpMethod, match?: RouteMatch): Permission {
    const action =
      method === "GET" || method === "HEAD" || match?.entry.handlerId.startsWith("audit")
        ? "read"
        : "write";
    const pkg = match?.params.pkg;
    const filename = match?.params.filename;
    return {
      action,
      ...(pkg
        ? {
            resource: filename
              ? { type: "artifact" as const, packageName: pkg, artifactRef: filename }
              : { type: "package" as const, packageName: pkg },
          }
        : {}),
    };
  }

  async findPackage(ctx: RegistryRequestContext, name: string) {
    return ctx.data.packages.findByName(name);
  }

  async liveVersionsFor(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    opts?: { orderByCreated?: "asc" | "desc" },
  ): Promise<RegistryPackageVersionRow[]> {
    return ctx.data.versions.listLive(pkg, opts);
  }

  async distTags(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
  ): Promise<Record<string, string>> {
    return ctx.data.tags.listLive(pkg);
  }

  async packumentToken(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    tags: Record<string, string>,
  ): Promise<string> {
    const versions = await ctx.data.versions.listLiveFingerprints(pkg);
    return JSON.stringify({
      tags: Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)),
      versions: versions.map((version) => [version.version, version.updatedAt.toISOString()]),
    });
  }

  packumentCacheKey(pkg: RegistryPackageHandle): string {
    return pkg.id;
  }

  async packumentEntry(
    ctx: RegistryRequestContext,
    name: string,
    pkg: RegistryPackageHandle,
    tags: Record<string, string>,
    token: string,
  ) {
    const key = this.packumentCacheKey(pkg);
    const cached = await this.packumentCache.get(ctx, key, () =>
      this.buildPackumentEntry(ctx, name, pkg, tags, token),
    );
    if (cached.body.token === token) return cached;
    const refreshed = await this.buildPackumentEntry(ctx, name, pkg, tags, token);
    this.packumentCache.set(ctx, key, refreshed);
    return refreshed;
  }

  private async buildPackumentEntry(
    ctx: RegistryRequestContext,
    name: string,
    pkg: RegistryPackageHandle,
    tags: Record<string, string>,
    token: string,
  ) {
    const versions = await this.liveVersionsFor(ctx, pkg);
    const text = JSON.stringify(buildPackument(name, versions, tags));
    return { body: { token, text }, etag: textEtag(text) };
  }

  whoamiUsername(ctx: RegistryRequestContext): string {
    const principal = ctx.principal;
    if (principal.kind === "user") return principal.username;
    if (principal.kind === "registryToken") return principal.subject;
    if (principal.kind === "token") {
      return principal.ownerUsername ?? principal.tokenName ?? `token:${principal.tokenId}`;
    }
    return "anonymous";
  }

  async generateMetadata(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<RegistryMetadata | null> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return null;
    const tags = await this.distTags(ctx, pkg);
    const token = await this.packumentToken(ctx, pkg, tags);
    const packed = await this.packumentEntry(ctx, name, pkg, tags, token);
    return {
      contentType: PACKUMENT_CONTENT_TYPE,
      body: packed.body.text,
    };
  }

  async mergeMetadata(parts: RegistryMetadata[]): Promise<RegistryMetadata> {
    return mergePackuments(parts);
  }

  async search(query: SearchQuery, ctx: RegistryRequestContext): Promise<SearchResult> {
    const { packages: rows, total } = await ctx.data.packages.search({
      text: query.text,
      from: 0,
      size: query.limit ?? 20,
    });
    return {
      items: rows.map((row) => ({ name: row.name })),
      total,
    };
  }

  async packument(name: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) throw Errors.notFound();
    const tags = await this.distTags(ctx, pkg);
    const token = await this.packumentToken(ctx, pkg, tags);
    const cached = await this.packumentEntry(ctx, name, pkg, tags, token);
    return textResponseWithEtag(
      req,
      cached.body.text,
      { "content-type": PACKUMENT_CONTENT_TYPE },
      cached.etag,
    );
  }

  async tarball(
    name: string,
    filename: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) throw Errors.notFound();
    const distVersion = versionFromTarballFilename(name, filename);
    const version = distVersion ? await this.versionRow(ctx, pkg, distVersion) : null;
    const metadata = version ? parseNpmStoredVersionMetadata(version.metadata) : null;
    const dist: NpmDist | undefined =
      metadata?.dist?.filename === filename ? metadata.dist : undefined;
    if (!dist || !distVersion) {
      throw Errors.notFound();
    }
    const etag = `"${dist.shasum}"`;
    return serveRegistryBlob(ctx, {
      digest: dist.blobDigest,
      kind: "npm_tarball",
      scope: `${name}@${distVersion}`,
      contentType: "application/octet-stream",
      req,
      etag,
      redirect: req.method === "GET",
      blocked: () => Response.json({ error: "artifact blocked by scan policy" }, { status: 403 }),
    });
  }

  async publish(name: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleNpmPublish(name, req, ctx);
  }

  async versionRow(ctx: RegistryRequestContext, pkg: RegistryPackageHandle, version: string) {
    return ctx.data.versions.findLive(pkg, version);
  }

  async distTagsList(name: string, ctx: RegistryRequestContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) throw Errors.notFound();
    return Response.json(await this.distTags(ctx, pkg));
  }

  async distTagSet(
    name: string,
    tag: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) throw Errors.notFound();
    tag = parseNpmDistTag(tag);
    const version = parseNpmDistTagRequestBody(await req.text());
    const row = await this.versionRow(ctx, pkg, version);
    if (!row) throw Errors.notFound();
    await ctx.data.tags.set(pkg, tag, row);
    if (tag === "latest") {
      await ctx.data.tags.updateLatestVersion(pkg, version);
    }
    return Response.json({ ok: true });
  }

  async distTagDelete(name: string, tag: string, ctx: RegistryRequestContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) throw Errors.notFound();
    tag = parseNpmDistTag(tag);
    await ctx.data.tags.delete(pkg, tag);
    if (tag === "latest") {
      await ctx.data.tags.updateLatestVersion(pkg, null);
    }
    return Response.json({ ok: true });
  }

  /** Pull-through: mirror an upstream package (all versions) into this proxy repo. */
  async proxyIngest(
    pkgName: string,
    upstreamBase: string,
    ctx: RegistryRequestContext,
  ): Promise<boolean> {
    return handleNpmProxyIngest(pkgName, upstreamBase, ctx);
  }

  async searchHandler(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const { text, from, size } = parseNpmSearchQuery(req.url);
    const { packages: rows, total } = await ctx.data.packages.search({ text, from, size });
    const tagsByPackageId = await ctx.data.tags.listLiveForPackages(rows);
    const preferredVersionsByPackageId = new Map(
      rows.flatMap((row) => {
        const latest = tagsByPackageId.get(row.id)?.latest;
        return latest ? [[row.id, latest] as const] : [];
      }),
    );
    const versionsByPackageId = await ctx.data.versions.listSearchVersionsForPackages(
      rows,
      preferredVersionsByPackageId,
    );

    const objects: NpmSearchObject[] = [];
    for (const p of rows) {
      const selected = versionsByPackageId.get(p.id);
      if (!selected) continue;
      objects.push(
        buildNpmSearchObject({
          packageName: p.name,
          selected,
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
        }),
      );
    }

    return Response.json(buildNpmSearchResponse({ objects, total }));
  }

  async handleVirtualSearch(input: RegistryVirtualSearchInput): Promise<Response> {
    const bodies = await input.collectMemberResponses(({ req }) => allNpmSearchResultsRequest(req));
    const result = mergeNpmSearchBodies(
      await Promise.all(
        bodies.map(async ({ response }) =>
          response.status >= 400
            ? null
            : parseNpmSearchBody(await response.json().catch(() => null)),
        ),
      ),
      npmSearchWindow(input.req),
    );
    return Response.json({
      ...result,
      time: new Date().toISOString(),
    });
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asJsonRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
}

function npmDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const manifest = parseNpmStoredVersionMetadata(metadata).manifest;
  return {
    ...stringRecord(manifest.dependencies),
    ...stringRecord(manifest.devDependencies),
  };
}

const npmDefinition = registryAdapter("npm")
  .stateClass(NpmAdapterState)
  .module((module) =>
    module
      .displayName("npm")
      .mount("npm")
      .capabilities("proxyable", "virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers(...COMPRESSIBLE_HANDLERS),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("npm")
      .purlType("npm")
      .dependencies(npmDependencyGraph)
      .referencedDigestPaths("dist.blobDigest"),
  )
  .basicAuth()
  .fromState((state) =>
    state
      .defaultPermission("requiredRoutePermission")
      .metadata({ generate: "generateMetadata", merge: "mergeMetadata" })
      .search("search")
      .virtualSearch("handleVirtualSearch")
      .proxyIngest("proxyIngest"),
  )
  .routes((route) => [
    route.get("/-/ping", "ping").json({}),
    route.get("/-/whoami", "whoami").json(({ ctx, state }) => ({
      username: state.whoamiUsername(ctx),
    })),
    route
      .searchGet("/-/v1/search", "search")
      .calls((state, { req, ctx }) => state.searchHandler(req, ctx)),
    route.post("/-/npm/v1/security/advisories/bulk", "auditBulk").json({}),
    route.post("/-/npm/v1/security/audits/quick", "auditQuick").json({
      advisories: {},
      vulnerabilities: {},
      metadata: {},
    }),
    route
      .get("/-/package/:pkg+/dist-tags", "distTagsList")
      .calls((state, { params, ctx }) => state.distTagsList(params.pkg, ctx)),
    route
      .put("/-/package/:pkg+/dist-tags/:tag", "distTagSet")
      .calls((state, { params, req, ctx }) => state.distTagSet(params.pkg, params.tag, req, ctx)),
    route
      .delete("/-/package/:pkg+/dist-tags/:tag", "distTagDelete")
      .calls((state, { params, ctx }) => state.distTagDelete(params.pkg, params.tag, ctx)),
    route
      .get("/:pkg+/-/:filename", "tarball")
      .params({ filename: tarballFilenameParam })
      .calls((state, { params, req, ctx }) => state.tarball(params.pkg, params.filename, req, ctx)),
    route
      .put("/:pkg+", "publish")
      .calls((state, { params, req, ctx }) => state.publish(params.pkg, req, ctx)),
    route
      .metadataGet("/:pkg+", "packument")
      .metadata("pkg", { proxyRefresh: true })
      .calls((state, { params, req, ctx }) => state.packument(params.pkg, req, ctx)),
  ]);

export class NpmAdapter extends npmDefinition.adapterClass() {}
export const npmRegistryPlugin = createRegistryAdapterPlugin(NpmAdapter);
