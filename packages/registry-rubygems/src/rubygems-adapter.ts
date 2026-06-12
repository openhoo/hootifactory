import {
  asJsonRecord,
  createRegistryAdapterPlugin,
  Errors,
  parseRegistryInput,
  type RegistryRequestContext,
  type RegistryVersionMetadataRow,
  registryAdapter,
  repoResponseCache,
  serveAssetBlob,
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

/** RubyGems: `.gem` push/yank + the compact-index protocol (`/versions`, `/info/<gem>`). */
class RubygemsAdapterState {
  readonly versionsCache = repoResponseCache<string>({ ttlMs: VERSIONS_CACHE_TTL_MS });

  clearVersionsCache(ctx: RegistryRequestContext): void {
    this.versionsCache.clear(ctx);
  }

  async push(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const res = await handleGemPush(req, ctx);
    if (res.status >= 200 && res.status < 300) this.clearVersionsCache(ctx);
    return res;
  }

  async yank(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async compactVersions(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const entry = await this.versionsCache.get(ctx, "versions", async () => {
      const rows = await ctx.data.versions.listRepositoryMetadata({ liveOnly: true });
      const body = buildVersionsBody(rows);
      return { body, etag: `"${md5Hex(body)}"` };
    });
    return textResponseWithEtag(req, entry.body, TEXT_PLAIN, entry.etag);
  }

  async compactInfo(gem: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await ctx.data.packages.findByName(gem);
    if (!pkg) throw Errors.notFound();
    const versions = await ctx.data.versions.listLive(pkg, { orderByCreated: "asc" });
    const entries = versions.flatMap((row) => {
      const entry = readGemVersionEntry(row.metadata, row.createdAt);
      return entry ? [entry] : [];
    });
    return textResponseWithEtag(req, buildInfoFile(entries), TEXT_PLAIN);
  }

  async compactNames(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = (await ctx.data.packages.listNames())
      .map((row) => row.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return textResponseWithEtag(req, `---\n${names.map((n) => `${n}\n`).join("")}`, TEXT_PLAIN);
  }

  async download(filename: string, _req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return serveAssetBlob(ctx, {
      role: GEM_KIND,
      kind: GEM_KIND,
      scope: filename,
      contentType: "application/octet-stream",
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

const rubygemsDefinition = registryAdapter("rubygems")
  .stateClass(RubygemsAdapterState)
  .module((module) =>
    module
      .displayName("RubyGems")
      .mount("rubygems")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("compactVersions", "compactInfo", "compactNames"),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("RubyGems")
      .purlType("gem")
      .dependencies(gemDependencyGraph)
      .referencedDigestPaths("gemDigest"),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([p.artifactRule({ param: "filename" }), p.packageRule({ param: "gem" })]),
  )
  .routes((route) => [
    route.post("/api/v1/gems", "push").calls((state, { req, ctx }) => state.push(req, ctx)),
    route.delete("/api/v1/gems/yank", "yank").calls((state, { req, ctx }) => state.yank(req, ctx)),
    route
      .get("/versions", "compactVersions")
      .calls((state, { req, ctx }) => state.compactVersions(req, ctx)),
    route
      .get("/names", "compactNames")
      .calls((state, { req, ctx }) => state.compactNames(req, ctx)),
    route
      .get("/info/:gem", "compactInfo")
      .params({ gem: { schema: GemNameSchema, code: "NAME_INVALID", message: "invalid gem name" } })
      .calls((state, { params, req, ctx }) => state.compactInfo(params.gem, req, ctx)),
    route
      .get("/gems/:filename", "download")
      .params({
        filename: {
          schema: GemFilenameSchema,
          code: "NAME_INVALID",
          message: "invalid gem filename",
        },
      })
      .calls((state, { params, req, ctx }) => state.download(params.filename, req, ctx)),
  ]);

export class RubygemsAdapter extends rubygemsDefinition.adapterClass() {}
export const rubygemsRegistryPlugin = createRegistryAdapterPlugin(RubygemsAdapter);
