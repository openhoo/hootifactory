import {
  basicAuthChallenge,
  defineRegistryPlugin,
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
  registryRoutes,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { handleNugetPublish } from "./nuget-publish-lifecycle";
import { buildNugetRegistrationIndex, buildNugetRegistrationItem } from "./nuget-registration";
import {
  buildNugetSearchResponse,
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

/**
 * NuGet v3. The consumption surface (service index + flat container) is
 * spec-compliant. Push accepts the .nupkg via PUT and derives id/version from
 * the nuspec when clients do not provide query parameters.
 */
export class NugetAdapter implements RegistryPlugin {
  readonly format = "nuget" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: false,
    virtualizable: true,
  };
  authChallenge = basicAuthChallenge;

  private readonly plugin = defineRegistryPlugin({
    format: this.format,
    capabilities: this.capabilities,
    authChallenge: this.authChallenge,
    routes: [
      registryRoutes.get("/v3/index.json", "serviceIndex", ({ ctx }) => this.serviceIndex(ctx)),
      registryRoutes.get("/v3/query", "search", ({ req, ctx }) =>
        this.nugetSearch(req, this.base(ctx), ctx),
      ),
      registryRoutes.put("/v3/package", "publish", ({ req, ctx }) => this.publish(req, ctx)),
      registryRoutes.delete("/v3/package/:id/:version", "delete", ({ params, ctx }) =>
        this.setListed(params.id ?? "", params.version ?? "", false, ctx),
      ),
      registryRoutes.post("/v3/package/:id/:version", "relist", ({ params, ctx }) =>
        this.setListed(params.id ?? "", params.version ?? "", true, ctx),
      ),
      registryRoutes.get("/v3-flatcontainer/:id/index.json", "versions", ({ params, ctx }) =>
        this.versions(params.id ?? "", ctx),
      ),
      registryRoutes.get("/v3-flatcontainer/:id/:version/:file", "download", ({ params, ctx }) =>
        this.download(params.id ?? "", params.version ?? "", params.file ?? "", ctx),
      ),
      registryRoutes.get("/v3/registrations/:id/index.json", "registration", ({ params, ctx }) =>
        this.registration(params.id ?? "", this.base(ctx), ctx),
      ),
      registryRoutes.get("/v3/registrations/:id/:file", "registrationLeaf", ({ params, ctx }) =>
        this.registrationLeaf(params.id ?? "", params.file ?? "", this.base(ctx), ctx),
      ),
    ],
  });
  private readonly delegate = delegateRegistryPlugin(this.plugin);

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

  private serviceIndex(ctx: RegistryRequestContext): Response {
    const base = this.base(ctx);
    return Response.json({
      version: "3.0.0",
      resources: [
        { "@id": `${base}/v3-flatcontainer/`, "@type": "PackageBaseAddress/3.0.0" },
        { "@id": `${base}/v3/package`, "@type": "PackagePublish/2.0.0" },
        { "@id": `${base}/v3/registrations/`, "@type": "RegistrationsBaseUrl/3.6.0" },
        { "@id": `${base}/v3/query`, "@type": "SearchQueryService/3.5.0" },
      ],
    });
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

  private async versions(id: string, ctx: RegistryRequestContext): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg, { includeUnlisted: true });
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    return Response.json({ versions: rows.map((r) => r.version) });
  }

  private async registration(
    id: string,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg, { includeUnlisted: true });
    return Response.json(
      buildNugetRegistrationIndex({
        id,
        base,
        versions: rows.map((row) => ({
          version: row.version,
          metadata: row.metadata,
        })),
      }),
    );
  }

  private async registrationLeaf(
    id: string,
    file: string,
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
    return Response.json(
      buildNugetRegistrationItem({
        id,
        version: row.version,
        metadata,
        base,
      }),
    );
  }

  private async nugetSearch(
    req: Request,
    base: string,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const query = parseNugetSearchQuery(req.url);
    const rows = await ctx.data.packages.list();
    const data = [];
    for (const pkg of rows) {
      if (query.q && !pkg.name.toLowerCase().includes(query.q)) continue;
      const versions = filterNugetSearchVersions(
        (await this.listVersions(ctx, pkg)).map((version) => ({
          version: version.version,
          metadata: version.metadata,
        })),
        query,
      );
      if (versions.length === 0) continue;
      data.push(buildNugetSearchResult({ packageName: pkg.name, versions, base }));
    }
    return Response.json(buildNugetSearchResponse(data, query));
  }

  private async download(
    id: string,
    version: string,
    file: string,
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
    return new Response(null, { status: listed ? 200 : 204 });
  }

  private async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleNugetPublish(req, ctx);
  }
}

export const nugetRegistryPlugin: RegistryPlugin = new NugetAdapter();
