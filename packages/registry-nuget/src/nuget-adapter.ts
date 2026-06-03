import {
  basicAuthChallenge,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
} from "@hootifactory/registry";
import {
  commitVersionOrReleaseBlob,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  findVersion,
  listLivePackageVersions,
  listRepositoryPackages,
  serveBlobIfClean,
  storeBlobWithRef,
  updatePackageVersionMetadata,
} from "@hootifactory/registry-application";
import { parseNugetPublishRequest } from "./nuget-publish";
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
} from "./nuget-validation";

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

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/v3/index.json", handlerId: "serviceIndex" },
      { method: "GET", pattern: "/v3/query", handlerId: "search" },
      { method: "PUT", pattern: "/v3/package", handlerId: "publish" },
      { method: "DELETE", pattern: "/v3/package/:id/:version", handlerId: "delete" },
      { method: "POST", pattern: "/v3/package/:id/:version", handlerId: "relist" },
      { method: "GET", pattern: "/v3-flatcontainer/:id/index.json", handlerId: "versions" },
      { method: "GET", pattern: "/v3-flatcontainer/:id/:version/:file", handlerId: "download" },
      { method: "GET", pattern: "/v3/registrations/:id/index.json", handlerId: "registration" },
      { method: "GET", pattern: "/v3/registrations/:id/:file", handlerId: "registrationLeaf" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return readWritePermission(method);
  }

  authChallenge = basicAuthChallenge;

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const base = `${ctx.baseUrl}/${ctx.repo.mountPath}`;
    switch (match.entry.handlerId) {
      case "serviceIndex":
        return Response.json({
          version: "3.0.0",
          resources: [
            { "@id": `${base}/v3-flatcontainer/`, "@type": "PackageBaseAddress/3.0.0" },
            { "@id": `${base}/v3/package`, "@type": "PackagePublish/2.0.0" },
            { "@id": `${base}/v3/registrations/`, "@type": "RegistrationsBaseUrl/3.6.0" },
            { "@id": `${base}/v3/query`, "@type": "SearchQueryService/3.5.0" },
          ],
        });
      case "search":
        return this.nugetSearch(req, base, ctx);
      case "publish":
        return this.publish(req, ctx);
      case "delete":
        return this.setListed(match.params.id ?? "", match.params.version ?? "", false, ctx);
      case "relist":
        return this.setListed(match.params.id ?? "", match.params.version ?? "", true, ctx);
      case "versions":
        return this.versions(match.params.id ?? "", ctx);
      case "download":
        return this.download(
          match.params.id ?? "",
          match.params.version ?? "",
          match.params.file ?? "",
          ctx,
        );
      case "registration":
        return this.registration(match.params.id ?? "", base, ctx);
      case "registrationLeaf":
        return this.registrationLeaf(match.params.id ?? "", match.params.file ?? "", base, ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async findPkg(ctx: RegistryRequestContext, id: string) {
    return findPackageByName(ctx, id.toLowerCase());
  }

  private async listVersions(
    ctx: RegistryRequestContext,
    packageId: string,
    opts: { includeUnlisted?: boolean } = {},
  ) {
    // Live versions only; sorted by SemVer so flat-container + registration bounds are correct.
    const rows = await listLivePackageVersions(ctx, packageId);
    return rows
      .filter(
        (r) => opts.includeUnlisted || (r.metadata as unknown as NugetVersionMeta).listed !== false,
      )
      .sort((a, b) => compareNugetVersions(a.version, b.version));
  }

  private async versions(id: string, ctx: RegistryRequestContext): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id, { includeUnlisted: true });
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
    const rows = await this.listVersions(ctx, pkg.id, { includeUnlisted: true });
    return Response.json(
      buildNugetRegistrationIndex({
        id,
        base,
        versions: rows.map((row) => ({
          version: row.version,
          metadata: row.metadata as unknown as NugetVersionMeta,
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
    const row = await findLiveVersion(ctx, pkg.id, norm);
    if (!row) throw Errors.notFound();
    return Response.json(
      buildNugetRegistrationItem({
        id,
        version: row.version,
        metadata: row.metadata as unknown as NugetVersionMeta,
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
    const rows = await listRepositoryPackages(ctx);
    const data = [];
    for (const pkg of rows) {
      if (query.q && !pkg.name.toLowerCase().includes(query.q)) continue;
      const versions = filterNugetSearchVersions(
        (await this.listVersions(ctx, pkg.id)).map((version) => ({
          version: version.version,
          metadata: version.metadata as unknown as NugetVersionMeta,
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
    const v = await findLiveVersion(ctx, pkg.id, norm);
    const digest = (v?.metadata as unknown as NugetVersionMeta | undefined)?.nupkgDigest;
    if (!digest || !(await ctx.blobs.exists(digest))) throw Errors.notFound();
    if (file.toLowerCase().endsWith(".nuspec")) {
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata><id>${escapeXml(id)}</id><version>${escapeXml(norm)}</version></metadata></package>\n`,
        { headers: { "content-type": "application/xml; charset=utf-8" } },
      );
    }
    return serveBlobIfClean(ctx, {
      digest,
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
    const row = await findLiveVersion(ctx, pkg.id, norm);
    if (!row) throw Errors.notFound();
    const metadata = (row.metadata ?? {}) as unknown as NugetVersionMeta;
    await updatePackageVersionMetadata(ctx, row.id, { ...metadata, listed });
    return new Response(null, { status: listed ? 200 : 204 });
  }

  private async publish(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const parsed = await parseNugetPublishRequest(req);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
    }
    const { bytes, file, lowerId, metadata, version } = parsed.plan;

    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: lowerId,
    });
    // NuGet packages are immutable. A retention tombstone still reserves the
    // normalized package version, so old bytes cannot be replaced by re-push.
    const existing = await findVersion(pkg.id, version);
    if (existing) return new Response(null, { status: 409 });

    const stored = await storeBlobWithRef(ctx, {
      data: bytes,
      kind: "generic_file",
      scope: file,
      mediaType: "application/octet-stream",
    });
    const result = await commitVersionOrReleaseBlob(ctx, {
      stored,
      kind: "generic_file",
      scope: file,
      packageId: pkg.id,
      version,
      metadata: {
        ...metadata,
        nupkgDigest: stored.digest,
      },
      sizeBytes: bytes.length,
      scan: {
        name: lowerId,
        version,
        mediaType: "application/octet-stream",
      },
    });
    if ("conflict" in result) {
      return new Response(null, { status: 409 });
    }
    return new Response(null, { status: 201 });
  }
}
