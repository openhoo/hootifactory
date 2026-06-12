import {
  createRegistryAdapterPlugin,
  Errors,
  ifNoneMatch,
  jsonResponseWithEtag,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPackageVersionFingerprintRow,
  type RegistryPackageVersionRow,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  type RegistryVirtualSearchInput,
  registryAdapter,
  repoResponseCache,
  serveVersionBlob,
  textEtag,
} from "@hootifactory/registry";
import { handleNugetPublish } from "./nuget-publish-lifecycle";
import { buildNugetRegistrationIndex, buildNugetRegistrationItem } from "./nuget-registration";
import {
  buildNugetSearchResult,
  filterNugetSearchVersions,
  parseNugetSearchQuery,
} from "./nuget-search";
import {
  compareNugetVersions,
  escapeXml,
  NugetFileSchema,
  NugetIdSchema,
  NugetVersionInputSchema,
  type NugetVersionMeta,
  normalizeNugetVersion,
  parseNugetVersionMeta,
} from "./nuget-validation";

type StoredNugetVersionRow = Omit<RegistryPackageVersionRow, "metadata"> & {
  metadata: NugetVersionMeta;
};

const NUGET_SEARCH_PACKAGE_BATCH_SIZE = 250;
const NUGET_REGISTRATION_CACHE_LIMIT = 256;

interface NugetRegistrationCacheBody {
  fingerprint: string;
  text: string;
}

const idParam: RegistryRouteParamSpec = {
  schema: NugetIdSchema,
  code: "NAME_INVALID",
  message: "invalid package id",
};

const versionParam: RegistryRouteParamSpec = {
  schema: NugetVersionInputSchema,
  code: "MANIFEST_UNKNOWN",
  message: "invalid package version",
  status: 404,
};

const fileParam: RegistryRouteParamSpec = {
  schema: NugetFileSchema,
  code: "NAME_INVALID",
  message: "invalid package filename",
};

/**
 * Still parsed in-handler: the registration leaf derives the version from the
 * `:file` segment (`{version}.json`), so it is not a route param of its own.
 */
function parseNugetVersionInput(version: string): string {
  return parseRegistryInput(NugetVersionInputSchema, version, {
    code: "MANIFEST_UNKNOWN",
    message: "invalid package version",
    status: 404,
  });
}

function registrationFingerprint(rows: RegistryPackageVersionFingerprintRow[]): string {
  return rows.map((row) => `${row.version}\0${row.updatedAt.getTime()}`).join("\n");
}

function registrationResponse(
  req: Request,
  entry: { body: NugetRegistrationCacheBody; etag: string },
): Response {
  if (ifNoneMatch(req, entry.etag)) {
    return new Response(null, { status: 304, headers: { etag: entry.etag } });
  }
  return new Response(entry.body.text, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      etag: entry.etag,
    },
  });
}

/**
 * NuGet v3. The consumption surface (service index + flat container) is
 * spec-compliant. Push accepts the .nupkg via PUT and derives id/version from
 * the nuspec when clients do not provide query parameters.
 */
class NugetAdapterState {
  readonly registrationCache = repoResponseCache<NugetRegistrationCacheBody>({
    maxEntries: NUGET_REGISTRATION_CACHE_LIMIT,
  });

  base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  serviceIndex(req: Request, ctx: RegistryRequestContext): Response {
    const base = this.base(ctx);
    return jsonResponseWithEtag(req, {
      version: "3.0.0",
      resources: [
        { "@id": `${base}/v3-flatcontainer/`, "@type": "PackageBaseAddress/3.0.0" },
        { "@id": `${base}/v3/package`, "@type": "PackagePublish/2.0.0" },
        { "@id": `${base}/v3/registrations/`, "@type": "RegistrationsBaseUrl/3.6.0" },
        { "@id": `${base}/v3/query`, "@type": "SearchQueryService/3.5.0" },
      ],
    });
  }

  async findPkg(ctx: RegistryRequestContext, id: string) {
    return ctx.data.packages.findByName(id.toLowerCase());
  }

  async listVersions(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    opts: { includeUnlisted?: boolean } = {},
  ): Promise<StoredNugetVersionRow[]> {
    // Live versions only; sorted by SemVer so flat-container + registration bounds are correct.
    const rows = await ctx.data.versions.listLive(pkg);
    return rows
      .flatMap((row) => {
        const metadata = parseNugetVersionMeta(row.metadata);
        if (!metadata) return [];
        if (!opts.includeUnlisted && metadata.listed === false) return [];
        return [{ ...row, metadata }];
      })
      .sort((a, b) => compareNugetVersions(a.version, b.version));
  }

  async versions(id: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const versions = (await ctx.data.versions.listLiveNames(pkg))
      .map((row) => row.version)
      .sort(compareNugetVersions);
    if (versions.length === 0) throw Errors.notFound();
    return jsonResponseWithEtag(req, { versions });
  }

  async registration(
    id: string,
    req: Request,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const cacheKey = this.registrationCacheKey(pkg, base);
    const fingerprint = registrationFingerprint(await ctx.data.versions.listLiveFingerprints(pkg));
    let cached = await this.registrationCache.get(ctx, cacheKey, () =>
      this.buildRegistrationEntry(ctx, pkg, id, base, fingerprint),
    );
    if (cached.body.fingerprint !== fingerprint) {
      cached = await this.buildRegistrationEntry(ctx, pkg, id, base, fingerprint);
      this.registrationCache.set(ctx, cacheKey, cached);
    }
    return registrationResponse(req, cached);
  }

  async registrationLeaf(
    id: string,
    file: string,
    req: Request,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    if (!file.toLowerCase().endsWith(".json")) throw Errors.notFound();
    const rawVersion = file.slice(0, -".json".length);
    const version = parseNugetVersionInput(rawVersion);
    const norm = normalizeNugetVersion(version);
    if (!norm) throw Errors.notFound();
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, norm);
    if (!row) throw Errors.notFound();
    const metadata = parseNugetVersionMeta(row.metadata);
    if (!metadata) throw Errors.notFound();
    return jsonResponseWithEtag(
      req,
      buildNugetRegistrationItem({
        id,
        version: row.version,
        metadata,
        base,
      }),
    );
  }

  async nugetSearch(req: Request, base: string, ctx: RegistryRequestContext): Promise<Response> {
    const query = parseNugetSearchQuery(req.url);
    const data = [];
    let totalHits = 0;
    let offset = 0;
    let totalPackages = 0;
    do {
      const { packages: rows, total } = await ctx.data.packages.search({
        text: query.q,
        from: offset,
        size: NUGET_SEARCH_PACKAGE_BATCH_SIZE,
      });
      totalPackages = total;
      offset += rows.length;
      if (rows.length === 0) break;
      const versionsByPackageId = await ctx.data.versions.listLiveForPackages(rows);
      for (const pkg of rows) {
        const versions = filterNugetSearchVersions(
          (versionsByPackageId.get(pkg.id) ?? [])
            .flatMap((version) => {
              const metadata = parseNugetVersionMeta(version.metadata);
              if (metadata?.listed === false) return [];
              return metadata ? [{ version: version.version, metadata }] : [];
            })
            .sort((a, b) => compareNugetVersions(a.version, b.version)),
          query,
        );
        if (versions.length === 0) continue;
        if (totalHits >= query.skip && data.length < query.take) {
          data.push(buildNugetSearchResult({ packageName: pkg.name, versions, base }));
        }
        totalHits += 1;
      }
    } while (offset < totalPackages);
    return jsonResponseWithEtag(req, { totalHits, data });
  }

  async download(
    id: string,
    version: string,
    file: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const norm = normalizeNugetVersion(version);
    if (!norm) throw Errors.notFound();
    // The filename segment must match the canonical {id}.{version}.nupkg this server builds.
    const ext = file.toLowerCase().endsWith(".nuspec") ? "nuspec" : "nupkg";
    const expected = `${id.toLowerCase()}.${norm}.${ext}`;
    if (file && file.toLowerCase() !== expected) throw Errors.notFound();
    if (file.toLowerCase().endsWith(".nuspec")) {
      const v = await ctx.data.versions.findLive(pkg, norm);
      const metadata = parseNugetVersionMeta(v?.metadata);
      if (!metadata?.nupkgDigest) throw Errors.notFound();
      if (metadata.nuspecXml) {
        return new Response(metadata.nuspecXml, {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      }
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata><id>${escapeXml(id)}</id><version>${escapeXml(norm)}</version></metadata></package>\n`,
        { headers: { "content-type": "application/xml; charset=utf-8" } },
      );
    }
    return serveVersionBlob<NugetVersionMeta>(ctx, {
      name: id.toLowerCase(),
      version: norm,
      kind: "generic_file",
      scope: `${id.toLowerCase()}.${norm}.nupkg`,
      parseMetadata: parseNugetVersionMeta,
      digest: ({ metadata }) => metadata.nupkgDigest,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
    });
  }

  async setListed(
    id: string,
    version: string,
    listed: boolean,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const norm = normalizeNugetVersion(version);
    if (!norm) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, norm);
    if (!row) throw Errors.notFound();
    const metadata = parseNugetVersionMeta(row.metadata);
    if (!metadata) throw Errors.notFound();
    await ctx.data.versions.updateMetadata(row, { ...metadata, listed });
    this.clearRegistrationCache(ctx);
    return new Response(null, { status: listed ? 200 : 204 });
  }

  async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleNugetPublish(req, ctx);
  }

  async handleVirtualSearch(input: RegistryVirtualSearchInput): Promise<Response> {
    const bodies = await input.collectMemberResponses(({ req }) =>
      allNugetSearchResultsRequest(req),
    );
    const parsed = await Promise.all(
      bodies.map(async ({ member, response }) =>
        response.status >= 400
          ? null
          : parseNugetSearchBody(await response.text(), member.mountPath, input.ctx.repo.mountPath),
      ),
    );
    return Response.json(mergeNugetSearchBodies(parsed, nugetSearchWindow(input.req)));
  }

  registrationCacheKey(pkg: RegistryPackageHandle, base: string): string {
    return `${pkg.id}\0${base}`;
  }

  private async buildRegistrationEntry(
    ctx: RegistryRequestContext,
    pkg: RegistryPackageHandle,
    id: string,
    base: string,
    fingerprint: string,
  ) {
    const rows = await this.listVersions(ctx, pkg, { includeUnlisted: true });
    const text = JSON.stringify(
      buildNugetRegistrationIndex({
        id,
        base,
        versions: rows.map((row) => ({
          version: row.version,
          metadata: row.metadata,
        })),
      }),
    );
    return { body: { fingerprint, text }, etag: textEtag(text) };
  }

  clearRegistrationCache(ctx: RegistryRequestContext): void {
    this.registrationCache.clear(ctx);
  }
}

interface NugetSearchBody {
  data?: Array<{ id?: unknown; [key: string]: unknown }>;
  totalHits?: number;
  [key: string]: unknown;
}

export function nugetSearchWindow(req: Request): { skip: number; take: number } {
  const url = new URL(req.url);
  return {
    skip: boundedSearchInteger(url.searchParams.get("skip"), { fallback: 0, min: 0, max: 10_000 }),
    take: boundedSearchInteger(url.searchParams.get("take"), { fallback: 20, min: 0, max: 100 }),
  };
}

export function allNugetSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("skip", "0");
  url.searchParams.set("take", "100");
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

export function parseNugetSearchBody(
  text: string,
  memberMountPath: string,
  virtualMountPath: string,
): NugetSearchBody | null {
  const rewritten =
    memberMountPath === virtualMountPath
      ? text
      : text.replaceAll(`/${memberMountPath}/`, `/${virtualMountPath}/`);
  try {
    const body = JSON.parse(rewritten) as NugetSearchBody;
    if (!Array.isArray(body.data)) return null;
    if (body.totalHits !== undefined && typeof body.totalHits !== "number") return null;
    return body;
  } catch {
    return null;
  }
}

export function mergeNugetSearchBodies(
  bodies: Iterable<NugetSearchBody | null>,
  window: { skip: number; take: number },
): { data: NonNullable<NugetSearchBody["data"]>; totalHits: number } {
  const seen = new Set<string>();
  const data: NonNullable<NugetSearchBody["data"]> = [];
  for (const body of bodies) {
    for (const item of body?.data ?? []) {
      const id = item.id;
      if (typeof id !== "string") continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      data.push(item);
    }
  }
  return {
    totalHits: data.length,
    data: data.slice(window.skip, window.skip + window.take),
  };
}

function boundedSearchInteger(
  value: string | null,
  opts: { fallback: number; min: number; max: number },
): number {
  if (value === null) return opts.fallback;
  const parsed = Number(value ?? opts.fallback);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < opts.min ||
    parsed > opts.max
  ) {
    throw Errors.paginationNumberInvalid();
  }
  return parsed;
}

function nugetDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = parseNugetVersionMeta(metadata);
  if (!parsed?.dependencyGroups) return {};
  const entries: [string, string][] = [];
  for (const group of parsed.dependencyGroups) {
    for (const dependency of group.dependencies ?? []) {
      entries.push([dependency.id, dependency.range]);
    }
  }
  return Object.fromEntries(entries);
}

const nugetDefinition = registryAdapter("nuget")
  .stateClass(NugetAdapterState)
  .module((module) =>
    module
      .displayName("NuGet")
      .mount("nuget")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .apiKeyHeaders("x-nuget-apikey")
      .compressibleHandlers(
        "serviceIndex",
        "search",
        "versions",
        "registration",
        "registrationLeaf",
      ),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("NuGet")
      .purlType("nuget")
      .dependencies(nugetDependencyGraph)
      .referencedDigestPaths("nupkgDigest"),
  )
  .basicAuth()
  .fromState((state) => state.virtualSearch("handleVirtualSearch"))
  .permissions((p) =>
    p.byParams([
      p.artifactRule({
        param: "file",
        normalize: (file, { params }) => (params.id && params.version ? file : null),
        packageName: ({ params }) => params.id?.toLowerCase(),
        artifactRef: (_file, { params }) => `${params.id?.toLowerCase()}.${params.version}.nupkg`,
      }),
      p.packageRule({ param: "id", normalize: (id) => id.toLowerCase() }),
    ]),
  )
  .routes((route) => [
    route
      .serviceIndex("/v3/index.json", "serviceIndex")
      .calls((state, { req, ctx }) => state.serviceIndex(req, ctx)),
    route
      .searchGet("/v3/query", "search")
      .calls((state, { req, ctx }) => state.nugetSearch(req, state.base(ctx), ctx)),
    route.put("/v3/package", "publish").calls((state, { req, ctx }) => state.publish(req, ctx)),
    route
      .delete("/v3/package/:id/:version", "delete")
      .params({ id: idParam, version: versionParam })
      .calls((state, { params, ctx }) => state.setListed(params.id, params.version, false, ctx)),
    route
      .post("/v3/package/:id/:version", "relist")
      .params({ id: idParam, version: versionParam })
      .calls((state, { params, ctx }) => state.setListed(params.id, params.version, true, ctx)),
    route
      .get("/v3-flatcontainer/:id/index.json", "versions")
      .params({ id: idParam })
      .calls((state, { params, req, ctx }) => state.versions(params.id, req, ctx)),
    route
      .get("/v3-flatcontainer/:id/:version/:file", "download")
      .params({ id: idParam, version: versionParam, file: fileParam })
      .calls((state, { params, req, ctx }) =>
        state.download(params.id, params.version, params.file, req, ctx),
      ),
    route
      .get("/v3/registrations/:id/index.json", "registration")
      .params({ id: idParam })
      .calls((state, { params, req, ctx }) =>
        state.registration(params.id, req, state.base(ctx), ctx),
      ),
    route
      .get("/v3/registrations/:id/:file", "registrationLeaf")
      .params({ id: idParam })
      .calls((state, { params, req, ctx }) =>
        state.registrationLeaf(params.id, params.file, req, state.base(ctx), ctx),
      ),
  ]);

export class NugetAdapter extends nugetDefinition.adapterClass() {}
export const nugetRegistryPlugin = createRegistryAdapterPlugin(NugetAdapter);
