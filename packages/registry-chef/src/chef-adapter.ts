import {
  parseRegistryInput,
  type RegistryMetadata,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  buildChefCookbook,
  buildChefCookbookList,
  buildChefCookbookListItem,
  buildChefCookbookVersion,
  buildChefUniverseEntry,
  type ChefCookbookListItem,
  type ChefStoredVersion,
  type ChefUniverse,
  chefVersionFromSegment,
  compareChefVersionsDesc,
} from "./chef-metadata";
import { handleChefProxyIngest } from "./chef-proxy-lifecycle";
import { chefBlobScope, handleChefPublish } from "./chef-publish-lifecycle";
import { ChefCookbookNameSchema, ChefVersionSchema, parseChefVersionMeta } from "./chef-validation";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const TARBALL_MEDIA_TYPE = "application/gzip";

function parseCookbookName(name: string): string {
  return parseRegistryInput(ChefCookbookNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid Chef cookbook name",
  });
}

function parseCookbookVersion(version: string): string {
  return parseRegistryInput(ChefVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid Chef cookbook version",
  });
}

/**
 * Chef Supermarket. Serves the `/universe` dependency document, the v1 cookbook
 * API (cookbook listing + per-version detail + tarball download), and accepts
 * `POST /api/v1/cookbooks` publishes (multipart `tarball` + `cookbook` JSON).
 * Proxyable (mirrors supermarket.chef.io) and virtualizable.
 */
class ChefAdapterState {
  /** All live versions of a cookbook, paired with their parsed metadata. */
  private async storedVersions(
    pkg: RegistryPackageHandle,
    ctx: RegistryRequestContext,
  ): Promise<ChefStoredVersion[]> {
    const rows = await ctx.data.versions.listLive(pkg, { orderByCreated: "desc" });
    return rows.flatMap((row) => {
      const metadata = parseChefVersionMeta(row.metadata);
      if (!metadata) return [];
      return [{ version: row.version, metadata, sizeBytes: row.sizeBytes }];
    });
  }

  /** `GET /universe` — the dependency-resolution document over all live cookbooks. */
  async universe(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const names = await ctx.data.packages.listNames();
    const universe: ChefUniverse = {};
    // Deterministic ordering so the ETag is stable across requests.
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const pkg = await ctx.data.packages.findByName(name);
      if (!pkg) continue;
      const versions = await this.storedVersions(pkg, ctx);
      if (versions.length === 0) continue;
      const entries: Record<string, ReturnType<typeof buildChefUniverseEntry>> = {};
      // Sort each cookbook's versions newest-first so the serialized key order
      // (and therefore the body + ETag) is deterministic regardless of the DB
      // row / proxy-ingest order, matching the buildChefCookbook listing.
      const sorted = [...versions].sort((a, b) => compareChefVersionsDesc(a.version, b.version));
      for (const { version, metadata } of sorted) {
        entries[version] = buildChefUniverseEntry({
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          name,
          version,
          metadata,
        });
      }
      universe[name] = entries;
    }
    return textResponseWithEtag(req, JSON.stringify(universe), {
      "content-type": JSON_CONTENT_TYPE,
    });
  }

  /**
   * `GET /api/v1/cookbooks` — the paginated cookbook index (`knife supermarket
   * list`). Returns the `{ start, total, items }` envelope; honors `items`/`start`
   * pagination and the `order` (alphabetical here) query params.
   */
  async cookbookIndex(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const allItems = await this.listItems(ctx);
    return this.paginatedListResponse(req, allItems);
  }

  /**
   * `GET /api/v1/search` — cookbook search (`knife supermarket search`). Same
   * `{ start, total, items }` envelope as the index, filtered by the `q` query
   * param (substring match over the cookbook name).
   */
  async searchCookbooks(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const allItems = await this.listItems(ctx);
    const query = new URL(req.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
    const matched = query
      ? allItems.filter((item) => item.cookbook_name.toLowerCase().includes(query))
      : allItems;
    return this.paginatedListResponse(req, matched);
  }

  /**
   * Build one list/search row per cookbook from its newest live version, ordered
   * alphabetically by cookbook name for a deterministic body + ETag.
   */
  private async listItems(ctx: RegistryRequestContext): Promise<ChefCookbookListItem[]> {
    const names = await ctx.data.packages.listNames();
    const items: ChefCookbookListItem[] = [];
    for (const { name } of [...names].sort((a, b) => a.name.localeCompare(b.name))) {
      const latest = await this.latestVersion(name, ctx);
      if (!latest) continue;
      items.push(
        buildChefCookbookListItem({
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          name,
          latest: latest.metadata,
        }),
      );
    }
    return items;
  }

  /** Window `items` by the `start`/`items` query params and render the envelope. */
  private paginatedListResponse(req: Request, items: ChefCookbookListItem[]): Response {
    const params = new URL(req.url).searchParams;
    const start = clampNonNegativeInt(params.get("start"), 0);
    // Supermarket defaults to 10 results per page; cap the window so a client
    // cannot request an unbounded slice.
    const size = clampPositiveInt(params.get("items"), 10, 100);
    const window = items.slice(start, start + size);
    const body = JSON.stringify(
      buildChefCookbookList({ items: window, total: items.length, start }),
    );
    return textResponseWithEtag(req, body, { "content-type": JSON_CONTENT_TYPE });
  }

  /** `GET /api/v1/cookbooks/:name` — the cookbook JSON (versions as URLs). */
  async cookbook(nameRaw: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const name = parseCookbookName(nameRaw);
    const body = await this.cookbookBody(name, ctx);
    if (!body) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(req, body, { "content-type": JSON_CONTENT_TYPE });
  }

  /** Serialized cookbook JSON, or null when the cookbook has no live versions. */
  private async cookbookBody(name: string, ctx: RegistryRequestContext): Promise<string | null> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;
    const versions = await this.storedVersions(pkg, ctx);
    const cookbook = buildChefCookbook({
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
      name,
      versions,
    });
    return cookbook ? JSON.stringify(cookbook) : null;
  }

  /** `GET /api/v1/cookbooks/:name/versions/:version` — single-version detail. */
  async cookbookVersion(
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseCookbookName(nameRaw);
    const stored = await this.resolveVersion(name, versionRaw, ctx);
    if (!stored) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(
      req,
      JSON.stringify(
        buildChefCookbookVersion({
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          name,
          version: stored,
        }),
      ),
      { "content-type": JSON_CONTENT_TYPE },
    );
  }

  /** `GET /api/v1/cookbooks/:name/versions/:version/download` — the tarball blob. */
  async download(
    nameRaw: string,
    versionRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const name = parseCookbookName(nameRaw);
    const stored = await this.resolveVersion(name, versionRaw, ctx);
    if (!stored) return new Response("Not Found", { status: 404 });
    return serveRegistryBlob(ctx, {
      digest: stored.metadata.tarballDigest,
      kind: "chef_cookbook",
      scope: chefBlobScope(name, stored.version),
      contentType: TARBALL_MEDIA_TYPE,
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  /**
   * Resolve a `:version` URL segment to a stored version. Supermarket accepts the
   * literal `latest` (VERSION_PATTERN = /latest|.../); we map it to the newest
   * live version. A concrete segment is normalized + validated as before. Returns
   * null (-> 404) when no matching live version exists.
   */
  private async resolveVersion(
    name: string,
    versionRaw: string,
    ctx: RegistryRequestContext,
  ): Promise<ChefStoredVersion | null> {
    if (versionRaw === "latest") return this.latestVersion(name, ctx);
    const version = parseCookbookVersion(chefVersionFromSegment(versionRaw));
    return this.findVersion(name, version, ctx);
  }

  /** The newest live version of a cookbook, or null when it has none. */
  private async latestVersion(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<ChefStoredVersion | null> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;
    const versions = await this.storedVersions(pkg, ctx);
    const sorted = [...versions].sort((a, b) => compareChefVersionsDesc(a.version, b.version));
    return sorted[0] ?? null;
  }

  /** A live cookbook version paired with its metadata, or null when not found. */
  private async findVersion(
    name: string,
    version: string,
    ctx: RegistryRequestContext,
  ): Promise<ChefStoredVersion | null> {
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return null;
    const row = await ctx.data.versions.findLive(pkg, version);
    const metadata = parseChefVersionMeta(row?.metadata);
    if (!row || !metadata) return null;
    return { version, metadata, sizeBytes: row.sizeBytes };
  }

  publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleChefPublish(req, ctx);
  }

  /** Virtual-merge source: the per-cookbook listing for `name`, or null if absent. */
  async buildCookbookMetadata(
    name: string,
    ctx: RegistryRequestContext,
  ): Promise<RegistryMetadata | null> {
    name = parseCookbookName(name);
    const body = await this.cookbookBody(name, ctx);
    if (!body) return null;
    return { contentType: JSON_CONTENT_TYPE, body };
  }

  /** Merge per-member cookbook listings: union their version URL lists, first wins. */
  async mergeCookbookMetadata(parts: RegistryMetadata[]): Promise<RegistryMetadata> {
    return mergeChefCookbooks(parts);
  }

  /** Pull-through: mirror an upstream Supermarket cookbook into this proxy repo. */
  ingestProxy(name: string, upstreamBase: string, ctx: RegistryRequestContext): Promise<boolean> {
    if (!ChefCookbookNameSchema.safeParse(name).success) return Promise.resolve(false);
    return handleChefProxyIngest(name, upstreamBase, ctx);
  }
}

/** Merge cookbook listings across virtual members, preferring the first member. */
export function mergeChefCookbooks(parts: RegistryMetadata[]): RegistryMetadata {
  let base: Record<string, unknown> | null = null;
  const versionUrls: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const body = typeof part.body === "string" ? part.body : new TextDecoder().decode(part.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    base ??= record;
    const urls = Array.isArray(record.versions) ? record.versions : [];
    for (const url of urls) {
      if (typeof url === "string" && !seen.has(url)) {
        seen.add(url);
        versionUrls.push(url);
      }
    }
  }
  const merged = { ...(base ?? {}), versions: sortVersionUrlsDesc(versionUrls) };
  return { contentType: JSON_CONTENT_TYPE, body: JSON.stringify(merged) };
}

/**
 * Re-sort merged cookbook `versions` URLs newest-first to preserve the plugin's
 * own contract (buildChefCookbook emits descending). URLs whose trailing segment
 * is not a recognizable version keep their original relative order, after the
 * parseable ones.
 */
function sortVersionUrlsDesc(urls: string[]): string[] {
  return urls
    .map((url, index) => ({ url, index, version: chefVersionFromUrl(url) }))
    .sort((a, b) => {
      if (a.version && b.version) return compareChefVersionsDesc(a.version, b.version);
      if (a.version) return -1;
      if (b.version) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.url);
}

/** Parse a query param as a non-negative integer, falling back to `fallback`. */
function clampNonNegativeInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Parse a query param as a positive integer in `[1, max]`, default `fallback`. */
function clampPositiveInt(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** Extract the dotted version from a `.../versions/<segment>` URL, or null. */
function chefVersionFromUrl(url: string): string | null {
  const segment = /\/versions\/([^/?#]+)/.exec(url)?.[1];
  if (!segment) return null;
  const version = chefVersionFromSegment(segment);
  return ChefVersionSchema.safeParse(version).success ? version : null;
}

function chefDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseChefVersionMeta(metadata);
  const deps = parsed?.dependencies;
  if (!deps) return {};
  return Object.fromEntries(Object.entries(deps).map(([name, range]) => [name, String(range)]));
}

const chefDefinition = registryAdapter("chef")
  .stateClass(ChefAdapterState)
  .module((module) =>
    module
      .displayName("Chef Supermarket")
      .mount("chef")
      .capabilities("proxyable", "virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("universe", "cookbook", "cookbookVersion"),
  )
  .scan({
    defaultOsvEcosystem: undefined,
    dependencyGraph: ({ metadata }) => ({
      deps: chefDependencyGraph(metadata),
      osvEcosystem: undefined,
      purlType: "chef",
    }),
    referencedDigests: (metadata) =>
      typeof metadata.tarballDigest === "string" ? [metadata.tarballDigest] : [],
  })
  .basicAuth()
  .fromState((state) =>
    state
      .metadata({ generate: "buildCookbookMetadata", merge: "mergeCookbookMetadata" })
      .proxyIngest("ingestProxy"),
  )
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "version",
        normalize: (versionRaw, { match, params }) => {
          if (match.entry.handlerId !== "download") return null;
          if (!params.name || !ChefCookbookNameSchema.safeParse(params.name).success) return null;
          const version = ChefVersionSchema.safeParse(chefVersionFromSegment(versionRaw)).success
            ? chefVersionFromSegment(versionRaw)
            : versionRaw;
          return chefBlobScope(params.name, version);
        },
        packageName: ({ params }) => params.name,
      }),
      p.packageRule({
        param: "name",
        normalize: (name) => (ChefCookbookNameSchema.safeParse(name).success ? name : null),
      }),
    ]),
  )
  .routes((route) => [
    // `/universe` is a literal segment declared before the `:name` catch-alls.
    // Real Supermarket maps the universe document at both `/universe` and the
    // versioned `/api/v1/universe`; mirror both to the same handler.
    route.get("/universe", "universe").calls((state, { req, ctx }) => state.universe(req, ctx)),
    route
      .get("/api/v1/universe", "universeV1")
      .calls((state, { req, ctx }) => state.universe(req, ctx)),
    // `GET /api/v1/search` (knife supermarket search) precedes the cookbook
    // catch-alls; it is a distinct path shape so ordering is for clarity only.
    route
      .get("/api/v1/search", "search")
      .calls((state, { req, ctx }) => state.searchCookbooks(req, ctx)),
    route
      .post("/api/v1/cookbooks", "publish")
      .calls((state, { req, ctx }) => state.publish(req, ctx)),
    // `GET /api/v1/cookbooks` (knife supermarket list) — declared before the
    // `:name` route; the empty-name shape never matches `/api/v1/cookbooks/:name`.
    route
      .get("/api/v1/cookbooks", "cookbookIndex")
      .calls((state, { req, ctx }) => state.cookbookIndex(req, ctx)),
    route
      .get("/api/v1/cookbooks/:name/versions/:version/download", "download")
      .calls((state, { params, req, ctx }) =>
        state.download(params.name, params.version, req, ctx),
      ),
    route
      .get("/api/v1/cookbooks/:name/versions/:version", "cookbookVersion")
      .calls((state, { params, req, ctx }) =>
        state.cookbookVersion(params.name, params.version, req, ctx),
      ),
    route
      .get("/api/v1/cookbooks/:name", "cookbook")
      .metadata("name", { proxyRefresh: true })
      .calls((state, { params, req, ctx }) => state.cookbook(params.name, req, ctx)),
  ]);

export class ChefAdapter extends chefDefinition.adapterClass() {}
export const chefRegistryPlugin: RegistryPlugin = new ChefAdapter();
