import {
  BoundedLruCache,
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  ifNoneMatch,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPackageVersionFingerprintRow,
  type RegistryPackageVersionRow,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RegistryVirtualSearchInput,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
  textEtag,
  textResponseWithEtag,
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

interface NugetRegistrationCacheEntry {
  fingerprint: string;
  body: string;
  etag: string;
}

function parseNugetId(id: string): string {
  return parseRegistryInput(NugetIdSchema, id, {
    code: "NAME_INVALID",
    message: "invalid package id",
  });
}

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
  entry: Pick<NugetRegistrationCacheEntry, "body" | "etag">,
): Response {
  if (ifNoneMatch(req, entry.etag)) {
    return new Response(null, { status: 304, headers: { etag: entry.etag } });
  }
  return new Response(entry.body, {
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
export class NugetAdapter implements RegistryPlugin {
  readonly id = "nuget" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "NuGet",
      mountSegment: "nuget",
      errorResponseKind: "singleError",
      apiKeyHeaders: ["x-nuget-apikey"],
      compressibleHandlers: [
        "serviceIndex",
        "search",
        "versions",
        "registration",
        "registrationLeaf",
      ],
      scan: {
        defaultOsvEcosystem: "NuGet",
        dependencyGraph: ({ metadata }) => ({
          deps: nugetDependencyGraph(metadata),
          osvEcosystem: "NuGet",
          purlType: "nuget",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.nupkgDigest === "string" ? [metadata.nupkgDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .virtualSearch((input) => this.handleVirtualSearch(input))
    .routes((route) => [
      route.get("/v3/index.json", "serviceIndex", ({ req, ctx }) => this.serviceIndex(req, ctx), {
        serviceIndex: true,
      }),
      route.get(
        "/v3/query",
        "search",
        ({ req, ctx }) => this.nugetSearch(req, this.base(ctx), ctx),
        {
          searchable: true,
        },
      ),
      route.put("/v3/package", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      route.delete("/v3/package/:id/:version", "delete", ({ params, ctx }) =>
        this.setListed(params.id, params.version, false, ctx),
      ),
      route.post("/v3/package/:id/:version", "relist", ({ params, ctx }) =>
        this.setListed(params.id, params.version, true, ctx),
      ),
      route.get("/v3-flatcontainer/:id/index.json", "versions", ({ params, req, ctx }) =>
        this.versions(params.id, req, ctx),
      ),
      route.get("/v3-flatcontainer/:id/:version/:file", "download", ({ params, req, ctx }) =>
        this.download(params.id, params.version, params.file, req, ctx),
      ),
      route.get("/v3/registrations/:id/index.json", "registration", ({ params, req, ctx }) =>
        this.registration(params.id, req, this.base(ctx), ctx),
      ),
      route.get("/v3/registrations/:id/:file", "registrationLeaf", ({ params, req, ctx }) =>
        this.registrationLeaf(params.id, params.file, req, this.base(ctx), ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);
  private readonly registrationCache = new BoundedLruCache<string, NugetRegistrationCacheEntry>(
    NUGET_REGISTRATION_CACHE_LIMIT,
  );

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
  get virtualSearch() {
    return this.plugin.virtualSearch;
  }

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const id = match?.params.id?.toLowerCase();
    const version = match?.params.version;
    const file = match?.params.file;
    if (id && version && file) {
      return {
        ...permission,
        resource: { type: "artifact", packageName: id, artifactRef: `${id}.${version}.nupkg` },
      };
    }
    if (id) return { ...permission, resource: { type: "package", packageName: id } };
    return permission;
  }

  handle = this.delegate.handle;

  private base(ctx: RegistryRequestContext): string {
    return `${ctx.baseUrl}/${ctx.repo.mountPath}`;
  }

  private serviceIndex(req: Request, ctx: RegistryRequestContext): Response {
    const base = this.base(ctx);
    return textResponseWithEtag(
      req,
      JSON.stringify({
        version: "3.0.0",
        resources: [
          { "@id": `${base}/v3-flatcontainer/`, "@type": "PackageBaseAddress/3.0.0" },
          { "@id": `${base}/v3/package`, "@type": "PackagePublish/2.0.0" },
          { "@id": `${base}/v3/registrations/`, "@type": "RegistrationsBaseUrl/3.6.0" },
          { "@id": `${base}/v3/query`, "@type": "SearchQueryService/3.5.0" },
        ],
      }),
      { "content-type": "application/json; charset=utf-8" },
    );
  }

  private async findPkg(ctx: RegistryRequestContext, id: string) {
    return ctx.data.packages.findByName(id.toLowerCase());
  }

  private async listVersions(
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

  private async versions(id: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const versions = (await ctx.data.versions.listLiveNames(pkg))
      .map((row) => row.version)
      .sort(compareNugetVersions);
    if (versions.length === 0) return new Response("Not Found", { status: 404 });
    return textResponseWithEtag(req, JSON.stringify({ versions }), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  private async registration(
    id: string,
    req: Request,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const cacheKey = this.registrationCacheKey(pkg, base);
    const fingerprint = registrationFingerprint(await ctx.data.versions.listLiveFingerprints(pkg));
    const cached = this.registrationCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) return registrationResponse(req, cached);

    const rows = await this.listVersions(ctx, pkg, { includeUnlisted: true });
    const body = JSON.stringify(
      buildNugetRegistrationIndex({
        id,
        base,
        versions: rows.map((row) => ({
          version: row.version,
          metadata: row.metadata,
        })),
      }),
    );
    const entry = { fingerprint, body, etag: textEtag(body) };
    this.putRegistrationCache(cacheKey, entry);
    return registrationResponse(req, entry);
  }

  private async registrationLeaf(
    id: string,
    file: string,
    req: Request,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseNugetId(id);
    if (!file.toLowerCase().endsWith(".json")) throw Errors.notFound();
    const rawVersion = file.slice(0, -".json".length);
    const version = parseNugetVersionInput(rawVersion);
    const norm = normalizeNugetVersion(version);
    if (!norm) throw Errors.notFound();
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const row = await ctx.data.versions.findLive(pkg, norm);
    if (!row) throw Errors.notFound();
    const metadata = parseNugetVersionMeta(row.metadata);
    if (!metadata) throw Errors.notFound();
    return textResponseWithEtag(
      req,
      JSON.stringify(
        buildNugetRegistrationItem({
          id,
          version: row.version,
          metadata,
          base,
        }),
      ),
      {
        "content-type": "application/json; charset=utf-8",
      },
    );
  }

  private async nugetSearch(
    req: Request,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
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
    return textResponseWithEtag(req, JSON.stringify({ totalHits, data }), {
      "content-type": "application/json; charset=utf-8",
    });
  }

  private async download(
    id: string,
    version: string,
    file: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseNugetId(id);
    version = parseNugetVersionInput(version);
    file = parseRegistryInput(NugetFileSchema, file, {
      code: "NAME_INVALID",
      message: "invalid package filename",
    });
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const norm = normalizeNugetVersion(version);
    if (!norm) throw Errors.notFound();
    // The filename segment must match the canonical {id}.{version}.nupkg this server builds.
    const ext = file.toLowerCase().endsWith(".nuspec") ? "nuspec" : "nupkg";
    const expected = `${id.toLowerCase()}.${norm}.${ext}`;
    if (file && file.toLowerCase() !== expected) throw Errors.notFound();
    const v = await ctx.data.versions.findLive(pkg, norm);
    const digest = parseNugetVersionMeta(v?.metadata)?.nupkgDigest;
    if (!digest) throw Errors.notFound();
    if (file.toLowerCase().endsWith(".nuspec")) {
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata><id>${escapeXml(id)}</id><version>${escapeXml(norm)}</version></metadata></package>\n`,
        { headers: { "content-type": "application/xml; charset=utf-8" } },
      );
    }
    return serveRegistryBlob(ctx, {
      digest,
      kind: "generic_file",
      scope: `${id.toLowerCase()}.${norm}.nupkg`,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
  }

  private async setListed(
    id: string,
    version: string,
    listed: boolean,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseNugetId(id);
    version = parseNugetVersionInput(version);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const norm = normalizeNugetVersion(version);
    if (!norm) throw Errors.notFound();
    const row = await ctx.data.versions.findLive(pkg, norm);
    if (!row) throw Errors.notFound();
    const metadata = parseNugetVersionMeta(row.metadata);
    if (!metadata) throw Errors.notFound();
    await ctx.data.versions.updateMetadata(row, { ...metadata, listed });
    this.clearRegistrationCacheForPackage(pkg.id);
    return new Response(null, { status: listed ? 200 : 204 });
  }

  private async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleNugetPublish(req, ctx);
  }

  private async handleVirtualSearch(input: RegistryVirtualSearchInput): Promise<Response> {
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

  private registrationCacheKey(pkg: RegistryPackageHandle, base: string): string {
    return `${pkg.id}\0${base}`;
  }

  private putRegistrationCache(cacheKey: string, entry: NugetRegistrationCacheEntry): void {
    this.registrationCache.set(cacheKey, entry);
  }

  private clearRegistrationCacheForPackage(packageId: string): void {
    const prefix = `${packageId}\0`;
    this.registrationCache.deleteWhere((key) => key.startsWith(prefix));
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

export const nugetRegistryPlugin: RegistryPlugin = new NugetAdapter();
