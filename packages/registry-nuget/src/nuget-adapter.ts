import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPackageVersionFingerprintRow,
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

function sha1hexText(data: string): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(data);
  return h.digest("hex");
}

function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
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
  readonly format = "nuget" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.format)
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/v3/index.json", "serviceIndex", ({ req, ctx }) => this.serviceIndex(req, ctx)),
      route.get("/v3/query", "search", ({ req, ctx }) =>
        this.nugetSearch(req, this.base(ctx), ctx),
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
  private readonly registrationCache = new Map<string, NugetRegistrationCacheEntry>();

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
    const entry = { fingerprint, body, etag: `"${sha1hexText(body)}"` };
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

  private registrationCacheKey(pkg: RegistryPackageHandle, base: string): string {
    return `${pkg.id}\0${base}`;
  }

  private putRegistrationCache(cacheKey: string, entry: NugetRegistrationCacheEntry): void {
    if (this.registrationCache.has(cacheKey)) this.registrationCache.delete(cacheKey);
    while (this.registrationCache.size >= NUGET_REGISTRATION_CACHE_LIMIT) {
      const oldest = this.registrationCache.keys().next().value;
      if (!oldest) break;
      this.registrationCache.delete(oldest);
    }
    this.registrationCache.set(cacheKey, entry);
  }

  private clearRegistrationCacheForPackage(packageId: string): void {
    const prefix = `${packageId}\0`;
    for (const key of this.registrationCache.keys()) {
      if (key.startsWith(prefix)) this.registrationCache.delete(key);
    }
  }
}

export const nugetRegistryPlugin: RegistryPlugin = new NugetAdapter();
