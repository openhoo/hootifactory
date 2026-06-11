import {
  Errors,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPackageVersionRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
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

const idParam: RegistryRouteParamSpec = {
  schema: ChocolateyIdSchema,
  code: "NAME_INVALID",
  message: "invalid package id",
};

const versionParam: RegistryRouteParamSpec = {
  schema: ChocolateyVersionInputSchema,
  code: "MANIFEST_UNKNOWN",
  message: "invalid package version",
  status: 404,
};

/**
 * Chocolatey registry: the NuGet OData v2 (Atom/XML) feed protocol that the
 * `choco` CLI speaks. Reads return Atom feeds/entries; push accepts a .nupkg
 * (multipart or raw) and derives id/version from the embedded nuspec.
 */
class ChocolateyAdapterState {
  base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  serviceDoc(ctx: RegistryRequestContext): Response {
    return new Response(buildServiceDocument(this.base(ctx)), {
      headers: { "content-type": XML_CONTENT_TYPE },
    });
  }

  metadata(): Response {
    return new Response(buildMetadataDocument(), {
      headers: { "content-type": XML_CONTENT_TYPE },
    });
  }

  async findPkg(ctx: RegistryRequestContext, id: string) {
    return ctx.data.packages.findByName(id.toLowerCase());
  }

  /** Parse + filter raw version rows into stored rows, sorted ascending by version. */
  storedVersions(
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
  async listVersions(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    opts: { includeUnlisted?: boolean } = {},
  ): Promise<StoredChocolateyVersionRow[]> {
    return this.storedVersions(await ctx.data.versions.listLive(pkg), opts);
  }

  entryInput(
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
  async listVersionsForAll(
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
  async packages(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async packageEntry(key: string, ctx: RegistryRequestContext): Promise<Response> {
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
  async findById(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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
  async chocolateySearch(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  async download(
    id: string,
    version: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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

  async unlist(id: string, version: string, ctx: RegistryRequestContext): Promise<Response> {
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

  async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

const chocolateyDefinition = registryAdapter("chocolatey")
  .stateClass(ChocolateyAdapterState)
  .module((module) =>
    module
      .displayName("Chocolatey")
      .mount("chocolatey")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .apiKeyHeaders("x-nuget-apikey")
      .compressibleHandlers(
        "serviceDoc",
        "metadata",
        "packages",
        "packageEntry",
        "findById",
        "search",
      )
      .compressibleContentTypes(ATOM_FEED_CONTENT_TYPE, ATOM_ENTRY_CONTENT_TYPE, XML_CONTENT_TYPE),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("NuGet")
      .purlType("nuget")
      .dependencies(chocolateyDependencyGraph)
      .referencedDigestPaths("nupkgDigest"),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "version",
        normalize: (version, { params }) => {
          if (!params.id) return null;
          const norm = normalizeChocolateyVersion(version) ?? version;
          return chocolateyBlobScope(params.id.toLowerCase(), norm);
        },
        packageName: ({ params }) => params.id?.toLowerCase(),
      }),
      p.artifactRule({
        param: "resource",
        normalize: (resource) => {
          const key = parseODataKey(resource);
          if (!key) return null;
          const norm = normalizeChocolateyVersion(key.version) ?? key.version;
          return chocolateyBlobScope(key.id.toLowerCase(), norm);
        },
        packageName: ({ params }) =>
          params.resource ? parseODataKey(params.resource)?.id.toLowerCase() : undefined,
      }),
      p.packageRule({ param: "id", normalize: (id) => id.toLowerCase() }),
    ]),
  )
  .routes((route) => [
    route.get("/api/v2", "serviceDoc").calls((state, { ctx }) => state.serviceDoc(ctx)),
    route.get("/api/v2/", "serviceDoc").calls((state, { ctx }) => state.serviceDoc(ctx)),
    route.get("/api/v2/$metadata", "metadata").calls((state) => state.metadata()),
    route
      .get("/api/v2/Packages()", "packages")
      .calls((state, { req, ctx }) => state.packages(req, ctx)),
    route
      .get("/api/v2/Packages", "packages")
      .calls((state, { req, ctx }) => state.packages(req, ctx)),
    route
      .get("/api/v2/FindPackagesById()", "findById")
      .calls((state, { req, ctx }) => state.findById(req, ctx)),
    route
      .searchGet("/api/v2/Search()", "search")
      .calls((state, { req, ctx }) => state.chocolateySearch(req, ctx)),
    route
      .get("/api/v2/package/:id/:version", "download")
      .params({ id: idParam, version: versionParam })
      .calls((state, { params, req, ctx }) => state.download(params.id, params.version, req, ctx)),
    route.put("/api/v2/package", "publish").calls((state, { req, ctx }) => state.publish(req, ctx)),
    route
      .delete("/api/v2/package/:id/:version", "unlist")
      .params({ id: idParam, version: versionParam })
      .calls((state, { params, ctx }) => state.unlist(params.id, params.version, ctx)),
    // The OData key segment `Packages(Id='X',Version='Y')` is one path segment;
    // the matcher only extracts params that are a whole segment, so this catch-all
    // (declared after the literal Packages routes) handles single-entry reads.
    route
      .get("/api/v2/:resource", "packageEntry")
      .calls((state, { params, ctx }) => state.packageEntry(params.resource, ctx)),
  ]);

export class ChocolateyAdapter extends chocolateyDefinition.adapterClass() {}
export const chocolateyRegistryPlugin: RegistryPlugin = new ChocolateyAdapter();
