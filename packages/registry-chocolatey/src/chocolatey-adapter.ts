import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPackageVersionRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  ATOM_ENTRY_CONTENT_TYPE,
  ATOM_FEED_CONTENT_TYPE,
  buildEntry,
  buildEntryDocument,
  buildFeed,
  buildMetadataDocument,
  buildServiceDocument,
  type ChocolateyEntryInput,
  XML_CONTENT_TYPE,
} from "./chocolatey-feed";
import { chocolateyBlobScope } from "./chocolatey-publish";
import { handleChocolateyPublish } from "./chocolatey-publish-lifecycle";
import { parseChocolateySearchQuery } from "./chocolatey-search";
import {
  ChocolateyIdSchema,
  ChocolateyVersionInputSchema,
  type ChocolateyVersionMeta,
  compareChocolateyVersions,
  isPrereleaseChocolateyVersion,
  normalizeChocolateyVersion,
  parseChocolateyVersionMeta,
  parseODataKey,
  toEdmDateTime,
  unquoteODataLiteral,
} from "./chocolatey-validation";

type StoredChocolateyVersionRow = Omit<RegistryPackageVersionRow, "metadata"> & {
  metadata: ChocolateyVersionMeta;
};

function parseChocolateyId(id: string): string {
  return parseRegistryInput(ChocolateyIdSchema, id, {
    code: "NAME_INVALID",
    message: "invalid package id",
  });
}

function parseChocolateyVersion(version: string): string {
  return parseRegistryInput(ChocolateyVersionInputSchema, version, {
    code: "MANIFEST_UNKNOWN",
    message: "invalid package version",
    status: 404,
  });
}

/**
 * Chocolatey registry: the NuGet OData v2 (Atom/XML) feed protocol that the
 * `choco` CLI speaks. Reads return Atom feeds/entries; push accepts a .nupkg
 * (multipart or raw) and derives id/version from the embedded nuspec.
 */
export class ChocolateyAdapter implements RegistryPlugin {
  readonly id = "chocolatey" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Chocolatey",
      mountSegment: "chocolatey",
      errorResponseKind: "singleError",
      apiKeyHeaders: ["x-nuget-apikey"],
      compressibleHandlers: [
        "serviceDoc",
        "metadata",
        "packages",
        "packageEntry",
        "findById",
        "search",
      ],
      compressibleContentTypes: [ATOM_FEED_CONTENT_TYPE, ATOM_ENTRY_CONTENT_TYPE, XML_CONTENT_TYPE],
      scan: {
        defaultOsvEcosystem: "NuGet",
        dependencyGraph: ({ metadata }) => ({
          deps: chocolateyDependencyGraph(metadata),
          osvEcosystem: "NuGet",
          purlType: "nuget",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.nupkgDigest === "string" ? [metadata.nupkgDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/api/v2", "serviceDoc", ({ ctx }) => this.serviceDoc(ctx)),
      route.get("/api/v2/", "serviceDoc", ({ ctx }) => this.serviceDoc(ctx)),
      route.get("/api/v2/$metadata", "metadata", () => this.metadata()),
      route.get("/api/v2/Packages()", "packages", ({ req, ctx }) => this.packages(req, ctx)),
      route.get("/api/v2/Packages", "packages", ({ req, ctx }) => this.packages(req, ctx)),
      route.get("/api/v2/FindPackagesById()", "findById", ({ req, ctx }) =>
        this.findById(req, ctx),
      ),
      route.get("/api/v2/Search()", "search", ({ req, ctx }) => this.chocolateySearch(req, ctx), {
        searchable: true,
      }),
      route.get("/api/v2/package/:id/:version", "download", ({ params, req, ctx }) =>
        this.download(params.id, params.version, req, ctx),
      ),
      route.put("/api/v2/package", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      route.delete("/api/v2/package/:id/:version", "unlist", ({ params, ctx }) =>
        this.unlist(params.id, params.version, ctx),
      ),
      // The OData key segment `Packages(Id='X',Version='Y')` is one path segment;
      // the matcher only extracts params that are a whole segment, so this catch-all
      // (declared after the literal Packages routes) handles single-entry reads.
      route.get("/api/v2/:resource", "packageEntry", ({ params, ctx }) =>
        this.packageEntry(params.resource, ctx),
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
    const id = match?.params.id?.toLowerCase();
    const version = match?.params.version;
    if (id && version) {
      // Normalize the version so the artifact ref matches the stored asset scope
      // (which is keyed by the normalized version). Fall back to the raw value if
      // it cannot be normalized so the authorize check still scopes to an artifact.
      const norm = normalizeChocolateyVersion(version) ?? version;
      return {
        ...permission,
        resource: {
          type: "artifact",
          packageName: id,
          artifactRef: chocolateyBlobScope(id, norm),
        },
      };
    }
    if (id) return { ...permission, resource: { type: "package", packageName: id } };
    return permission;
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  private serviceDoc(ctx: RegistryRequestContext): Response {
    return new Response(buildServiceDocument(this.base(ctx)), {
      headers: { "content-type": XML_CONTENT_TYPE },
    });
  }

  private metadata(): Response {
    return new Response(buildMetadataDocument(), {
      headers: { "content-type": XML_CONTENT_TYPE },
    });
  }

  private async findPkg(ctx: RegistryRequestContext, id: string) {
    return ctx.data.packages.findByName(id.toLowerCase());
  }

  /** Parse + filter raw version rows into stored rows, sorted ascending by version. */
  private storedVersions(
    rows: RegistryPackageVersionRow[],
    opts: { includeUnlisted?: boolean } = {},
  ): StoredChocolateyVersionRow[] {
    return rows
      .flatMap((row) => {
        const metadata = parseChocolateyVersionMeta(row.metadata);
        if (!metadata) return [];
        if (!opts.includeUnlisted && metadata.listed === false) return [];
        return [{ ...row, metadata }];
      })
      .sort((a, b) => compareChocolateyVersions(a.version, b.version));
  }

  /** Live versions for a package, newest-version metadata parsed + sorted ascending. */
  private async listVersions(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    opts: { includeUnlisted?: boolean } = {},
  ): Promise<StoredChocolateyVersionRow[]> {
    return this.storedVersions(await ctx.data.versions.listLive(pkg), opts);
  }

  private entryInput(
    rows: StoredChocolateyVersionRow[],
    row: StoredChocolateyVersionRow,
  ): ChocolateyEntryInput {
    // NuGet computes IsLatestVersion/IsAbsoluteLatestVersion over LISTED versions
    // only — an unlisted newest version never suppresses a listed one.
    const listed = rows.filter((r) => r.metadata.listed !== false);
    const stable = listed.filter((r) => !isPrereleaseChocolateyVersion(r.version));
    const absoluteLatest = listed[listed.length - 1];
    const stableLatest = stable[stable.length - 1];
    return {
      metadata: row.metadata,
      isLatestVersion: row.version === stableLatest?.version,
      isAbsoluteLatestVersion: row.version === absoluteLatest?.version,
      published: toEdmDateTime(row.createdAt),
    };
  }

  /**
   * Fetch + group live versions for every package in one batch (avoids the N+1
   * per-package `listLive` calls). Returns one stored-row list per package id.
   */
  private async listVersionsForAll(
    ctx: RegistryRequestContext,
    pkgs: RegistryPackageHandle[],
  ): Promise<Map<string, StoredChocolateyVersionRow[]>> {
    const grouped = await ctx.data.versions.listLiveForPackages(pkgs);
    const result = new Map<string, StoredChocolateyVersionRow[]>();
    for (const pkg of pkgs) {
      result.set(pkg.id, this.storedVersions(grouped.get(pkg.id) ?? []));
    }
    return result;
  }

  /** `Packages()` — a feed of the latest (absolute-latest) version per package. */
  private async packages(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const base = this.base(ctx);
    const summaries = await ctx.data.packages.list();
    const byPackage = await this.listVersionsForAll(ctx, summaries);
    const entries: string[] = [];
    for (const summary of summaries) {
      const rows = byPackage.get(summary.id) ?? [];
      const latest = rows[rows.length - 1];
      if (latest) entries.push(buildEntry(base, this.entryInput(rows, latest)));
    }
    return textResponseWithEtag(req, buildFeed(base, entries), {
      "content-type": ATOM_FEED_CONTENT_TYPE,
    });
  }

  /** `Packages(Id='X',Version='Y')` — a single entry for one exact version. */
  private async packageEntry(key: string, ctx: RegistryRequestContext): Promise<Response> {
    const parsedKey = parseODataKey(key);
    if (!parsedKey) throw Errors.notFound();
    const id = parseChocolateyId(parsedKey.id);
    const norm = normalizeChocolateyVersion(parseChocolateyVersion(parsedKey.version));
    if (!norm) throw Errors.notFound();
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const rows = await this.listVersions(ctx, pkg, { includeUnlisted: true });
    const row = rows.find((r) => r.version === norm);
    if (!row) throw Errors.notFound();
    return new Response(
      buildEntryDocument(buildEntry(this.base(ctx), this.entryInput(rows, row))),
      { headers: { "content-type": ATOM_ENTRY_CONTENT_TYPE } },
    );
  }

  /** `FindPackagesById()?id='X'` — a feed of ALL versions of X. */
  private async findById(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const base = this.base(ctx);
    const rawId = unquoteODataLiteral(new URL(req.url).searchParams.get("id"));
    if (!rawId) return textResponseWithEtag(req, buildFeed(base, []), feedHeaders());
    const id = parseChocolateyId(rawId);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return textResponseWithEtag(req, buildFeed(base, []), feedHeaders());
    const rows = await this.listVersions(ctx, pkg, { includeUnlisted: true });
    const entries = rows.map((row) => buildEntry(base, this.entryInput(rows, row)));
    return textResponseWithEtag(req, buildFeed(base, entries), feedHeaders());
  }

  /** `Search()` — a feed of the latest matching version per package. */
  private async chocolateySearch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const base = this.base(ctx);
    const query = parseChocolateySearchQuery(req.url);
    const summaries = await ctx.data.packages.list();
    const byPackage = await this.listVersionsForAll(ctx, summaries);
    const matched: string[] = [];
    let skipped = 0;
    for (const summary of summaries) {
      const rows = byPackage.get(summary.id) ?? [];
      const candidates = query.includePrerelease
        ? rows
        : rows.filter((r) => !isPrereleaseChocolateyVersion(r.version));
      const latest = candidates[candidates.length - 1];
      if (!latest) continue;
      // NuGet Search() matches id, title, tags, and description (not just id).
      if (!searchMatches(query.term, summary.name, latest.metadata)) continue;
      if (skipped < query.skip) {
        skipped += 1;
        continue;
      }
      if (matched.length >= query.top) break;
      matched.push(buildEntry(base, this.entryInput(rows, latest)));
    }
    return textResponseWithEtag(req, buildFeed(base, matched), feedHeaders());
  }

  private async download(
    id: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseChocolateyId(id);
    version = parseChocolateyVersion(version);
    const norm = normalizeChocolateyVersion(version);
    if (!norm) throw Errors.notFound();
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, norm);
    const digest = parseChocolateyVersionMeta(row?.metadata)?.nupkgDigest;
    if (!digest) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest,
      kind: "generic_file",
      scope: chocolateyBlobScope(id.toLowerCase(), norm),
      contentType: "application/zip",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async unlist(
    id: string,
    version: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseChocolateyId(id);
    version = parseChocolateyVersion(version);
    const norm = normalizeChocolateyVersion(version);
    if (!norm) throw Errors.notFound();
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, norm);
    if (!row) throw Errors.notFound();
    const metadata = parseChocolateyVersionMeta(row.metadata);
    if (!metadata) throw Errors.notFound();
    await ctx.data.versions.updateMetadata(row, { ...metadata, listed: false });
    return new Response(null, { status: 204 });
  }

  private async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleChocolateyPublish(req, ctx);
  }
}

function feedHeaders(): Record<string, string> {
  return { "content-type": ATOM_FEED_CONTENT_TYPE };
}

/** NuGet Search() matches the term against id, title, tags, and description. */
function searchMatches(term: string, name: string, metadata: ChocolateyVersionMeta): boolean {
  if (!term) return true;
  const haystack = [name, metadata.id, metadata.title, metadata.tags, metadata.description];
  return haystack.some((field) => field?.toLowerCase().includes(term));
}

function chocolateyDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseChocolateyVersionMeta(metadata);
  if (!parsed?.dependencies) return {};
  return Object.fromEntries(parsed.dependencies.map((dep) => [dep.id, dep.range]));
}

export const chocolateyRegistryPlugin: RegistryPlugin = new ChocolateyAdapter();
