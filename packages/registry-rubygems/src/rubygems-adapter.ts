import {
  asJsonRecord,
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RegistryVersionMetadataRow,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  buildInfoFile,
  buildVersionsFile,
  type GemVersionEntry,
  type GemVersionsSummary,
  gemVersionIdentifier,
  md5Hex,
  readGemName,
  readGemVersionEntry,
} from "./rubygems-compact-index";
import { GEM_KIND, handleGemPush } from "./rubygems-publish-lifecycle";
import { GemFilenameSchema, GemNameSchema, GemVersionSchema } from "./rubygems-validation";

const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" } as const;
const VERSIONS_CACHE_TTL_MS = 5_000;

interface VersionsCacheEntry {
  body: string;
  etag: string;
  expiresAt: number;
}

/** RubyGems: `.gem` push/yank + the compact-index protocol (`/versions`, `/info/<gem>`). */
export class RubygemsAdapter implements RegistryPlugin {
  readonly id = "rubygems" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;
  private readonly versionsCache = new Map<string, VersionsCacheEntry>();

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "RubyGems",
      mountSegment: "rubygems",
      errorResponseKind: "singleError",
      compressibleHandlers: ["compactVersions", "compactInfo", "compactNames"],
      scan: {
        defaultOsvEcosystem: "RubyGems",
        dependencyGraph: ({ metadata }) => ({
          deps: gemDependencyGraph(metadata),
          osvEcosystem: "RubyGems",
          purlType: "gem",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.gemDigest === "string" ? [metadata.gemDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.post("/api/v1/gems", "push", ({ req, ctx }) => this.push(req, ctx)),
      route.delete("/api/v1/gems/yank", "yank", ({ req, ctx }) => this.yank(req, ctx)),
      route.get("/versions", "compactVersions", ({ req, ctx }) => this.compactVersions(req, ctx)),
      route.get("/names", "compactNames", ({ req, ctx }) => this.compactNames(req, ctx)),
      route.get("/info/:gem", "compactInfo", ({ params, req, ctx }) =>
        this.compactInfo(params.gem, req, ctx),
      ),
      route.get("/gems/:filename", "download", ({ params, req, ctx }) =>
        this.download(params.filename, req, ctx),
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
    const filename = match?.params.filename;
    const gem = match?.params.gem;
    if (filename) {
      return { ...permission, resource: { type: "artifact", artifactRef: filename } };
    }
    if (gem) {
      return { ...permission, resource: { type: "package", packageName: gem } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private cacheKey(ctx: RegistryRequestContext): string {
    return ctx.repo.id;
  }

  private cachedVersions(ctx: RegistryRequestContext): VersionsCacheEntry | null {
    const entry = this.versionsCache.get(this.cacheKey(ctx));
    if (!entry) return null;
    if (entry.expiresAt > Date.now()) return entry;
    this.versionsCache.delete(this.cacheKey(ctx));
    return null;
  }

  private storeVersions(ctx: RegistryRequestContext, body: string): VersionsCacheEntry {
    const entry = {
      body,
      etag: `"${md5Hex(body)}"`,
      expiresAt: Date.now() + VERSIONS_CACHE_TTL_MS,
    };
    this.versionsCache.set(this.cacheKey(ctx), entry);
    return entry;
  }

  private clearVersionsCache(ctx: RegistryRequestContext): void {
    this.versionsCache.delete(this.cacheKey(ctx));
  }

  private async push(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const res = await handleGemPush(req, ctx);
    if (res.status >= 200 && res.status < 300) this.clearVersionsCache(ctx);
    return res;
  }

  private async yank(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const { gemName, version } = await readYankParams(req);
    if (!gemName || !version) {
      return new Response("gem_name and version are required", { status: 400 });
    }
    const name = parseRegistryInput(GemNameSchema, gemName, {
      code: "NAME_INVALID",
      message: "invalid gem name",
    });
    const parsedVersion = parseRegistryInput(GemVersionSchema, version, {
      code: "NAME_INVALID",
      message: "invalid gem version",
    });
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, parsedVersion);
    if (!row) throw Errors.notFound();
    const metadata = asJsonRecord(row.metadata) ?? {};
    const index = asJsonRecord(metadata.index) ?? {};
    await ctx.data.versions.updateMetadata(row, {
      ...metadata,
      index: { ...index, yanked: true },
    });
    this.clearVersionsCache(ctx);
    return new Response(`Yanked gem: ${name} (${parsedVersion})`, { status: 200 });
  }

  private async compactVersions(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const cached = this.cachedVersions(ctx);
    if (cached) return textResponseWithEtag(req, cached.body, TEXT_PLAIN, cached.etag);
    const rows = await ctx.data.versions.listRepositoryMetadata({ liveOnly: true });
    const entry = this.storeVersions(ctx, buildVersionsBody(rows));
    return textResponseWithEtag(req, entry.body, TEXT_PLAIN, entry.etag);
  }

  private async compactInfo(
    gem: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseRegistryInput(GemNameSchema, gem, {
      code: "NAME_INVALID",
      message: "invalid gem name",
    });
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const versions = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    const entries = versions.flatMap((row) => {
      const entry = readGemVersionEntry(row.metadata, row.createdAt);
      return entry ? [entry] : [];
    });
    return textResponseWithEtag(req, buildInfoFile(entries), TEXT_PLAIN);
  }

  private async compactNames(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = (await ctx.data.packages.listNames())
      .map((row) => row.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return textResponseWithEtag(req, `---\n${names.map((n) => `${n}\n`).join("")}`, TEXT_PLAIN);
  }

  private async download(
    filename: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    filename = parseRegistryInput(GemFilenameSchema, filename, {
      code: "NAME_INVALID",
      message: "invalid gem filename",
    });
    const asset = await ctx.data.assets.findByScope({ role: GEM_KIND, scope: filename });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: GEM_KIND,
      scope: filename,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("gem blocked by scan policy", { status: 403 }),
    });
  }
}

/** Group every repo version into the compact-index `/versions` document. */
export function buildVersionsBody(rows: RegistryVersionMetadataRow[]): string {
  const byGem = new Map<string, GemVersionEntry[]>();
  let latestMs = 0;
  for (const row of rows) {
    const name = readGemName(row.metadata);
    const entry = readGemVersionEntry(row.metadata, row.createdAt);
    if (!name || !entry) continue;
    const list = byGem.get(name) ?? [];
    list.push(entry);
    byGem.set(name, list);
    latestMs = Math.max(latestMs, row.createdAt.getTime());
  }
  const summaries: GemVersionsSummary[] = [];
  for (const [name, entries] of [...byGem.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const live = entries.filter((entry) => !entry.yanked);
    if (live.length === 0) continue;
    summaries.push({
      name,
      versions: live.map((entry) => gemVersionIdentifier(entry)),
      infoChecksum: md5Hex(buildInfoFile(entries)),
    });
  }
  const createdAt = latestMs > 0 ? new Date(latestMs).toISOString() : "1970-01-01T00:00:00Z";
  return buildVersionsFile(createdAt, summaries);
}

async function readYankParams(req: Request): Promise<{ gemName?: string; version?: string }> {
  const url = new URL(req.url);
  let gemName = url.searchParams.get("gem_name") ?? undefined;
  let version = url.searchParams.get("version") ?? undefined;
  if (!gemName || !version) {
    // `gem yank` form-encodes the parameters in the DELETE body.
    const params = new URLSearchParams(await req.text().catch(() => ""));
    gemName = gemName ?? params.get("gem_name") ?? undefined;
    version = version ?? params.get("version") ?? undefined;
  }
  return { gemName, version };
}

function gemDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const index = asJsonRecord(metadata.index);
  if (!index || !Array.isArray(index.deps)) return {};
  const out: Record<string, string> = {};
  for (const dep of index.deps) {
    const entry = asJsonRecord(dep);
    if (entry && typeof entry.name === "string" && typeof entry.requirements === "string") {
      out[entry.name] = entry.requirements;
    }
  }
  return out;
}

export const rubygemsRegistryPlugin: RegistryPlugin = new RubygemsAdapter();
