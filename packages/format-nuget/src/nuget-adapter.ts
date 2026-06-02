import {
  basicAuthChallenge,
  commitVersionOrReleaseBlob,
  Errors,
  type FormatAdapter,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  findVersion,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  readWritePermission,
  serveBlobIfClean,
  storeBlobWithRef,
} from "@hootifactory/core";
import { and, eq, isNull, packages, packageVersions } from "@hootifactory/db";
import { extractMultipartFile, MultipartContentTypeSchema } from "./nuget-multipart";
import {
  compareNugetVersions,
  escapeXml,
  isPrereleaseNugetVersion,
  isSemVer2NugetVersion,
  NugetFileSchema,
  NugetIdSchema,
  NugetPublishQuerySchema,
  NugetVersionInputSchema,
  type NugetVersionMeta,
  normalizeNugetVersion,
} from "./nuget-validation";
import { extractNuspecMeta } from "./nuspec";

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
export class NugetAdapter implements FormatAdapter {
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

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
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

  private async findPkg(ctx: RepoContext, id: string) {
    return findPackageByName(ctx, id.toLowerCase());
  }

  private async listVersions(
    ctx: RepoContext,
    packageId: string,
    opts: { includeUnlisted?: boolean } = {},
  ) {
    const rows = await ctx.db
      .select({ version: packageVersions.version, metadata: packageVersions.metadata })
      .from(packageVersions)
      // Live versions only; sorted by SemVer so flat-container + registration bounds are correct.
      .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
    return rows
      .filter(
        (r) => opts.includeUnlisted || (r.metadata as unknown as NugetVersionMeta).listed !== false,
      )
      .sort((a, b) => compareNugetVersions(a.version, b.version));
  }

  private async versions(id: string, ctx: RepoContext): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id, { includeUnlisted: true });
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    return Response.json({ versions: rows.map((r) => r.version) });
  }

  private registrationItem(input: {
    id: string;
    version: string;
    metadata: NugetVersionMeta;
    base: string;
  }) {
    const lower = input.id.toLowerCase();
    const displayId = input.metadata.displayId ?? input.id;
    const leaf = `${input.base}/v3/registrations/${lower}/${input.version}.json`;
    const content = `${input.base}/v3-flatcontainer/${lower}/${input.version}/${lower}.${input.version}.nupkg`;
    const dependencyGroups = (input.metadata.dependencyGroups ?? []).map((group) => ({
      ...(group.targetFramework ? { targetFramework: group.targetFramework } : {}),
      dependencies: group.dependencies.map((dep) => ({
        id: dep.id,
        range: dep.range,
        registration: `${input.base}/v3/registrations/${dep.id.toLowerCase()}/index.json`,
      })),
    }));
    return {
      "@id": leaf,
      "@type": "Package",
      catalogEntry: {
        "@id": leaf,
        "@type": "PackageDetails",
        id: displayId,
        version: input.version,
        listed: input.metadata.listed !== false,
        packageContent: content,
        ...(dependencyGroups.length > 0 ? { dependencyGroups } : {}),
      },
      packageContent: content,
      registrationLeafUrl: leaf,
      registration: `${input.base}/v3/registrations/${lower}/index.json`,
    };
  }

  private async registration(id: string, base: string, ctx: RepoContext): Promise<Response> {
    id = parseNugetId(id);
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id, { includeUnlisted: true });
    const lower = id.toLowerCase();
    const registrationUrl = `${base}/v3/registrations/${lower}/index.json`;
    const items = rows.map((r) =>
      this.registrationItem({
        id,
        version: r.version,
        metadata: r.metadata as unknown as NugetVersionMeta,
        base,
      }),
    );
    const pages =
      rows.length === 0
        ? []
        : [
            {
              "@id": registrationUrl,
              count: items.length,
              lower: rows[0]?.version,
              upper: rows[rows.length - 1]?.version,
              items,
            },
          ];
    return Response.json({ count: pages.length, items: pages });
  }

  private async registrationLeaf(
    id: string,
    file: string,
    base: string,
    ctx: RepoContext,
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
      this.registrationItem({
        id,
        version: row.version,
        metadata: row.metadata as unknown as NugetVersionMeta,
        base,
      }),
    );
  }

  private async nugetSearch(req: Request, base: string, ctx: RepoContext): Promise<Response> {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const skip = Math.max(0, Number(url.searchParams.get("skip") ?? 0) || 0);
    const take = Math.min(100, Math.max(0, Number(url.searchParams.get("take") ?? 20) || 20));
    const includePrerelease = (url.searchParams.get("prerelease") ?? "").toLowerCase() === "true";
    const includeSemVer2 = (url.searchParams.get("semVerLevel") ?? "") === "2.0.0";
    const rows = await ctx.db
      .select({ id: packages.id, name: packages.name })
      .from(packages)
      .where(eq(packages.repositoryId, ctx.repo.id));
    const data = [];
    for (const pkg of rows) {
      if (q && !pkg.name.toLowerCase().includes(q)) continue;
      const versions = (await this.listVersions(ctx, pkg.id)).filter((version) => {
        const metadata = version.metadata as unknown as NugetVersionMeta;
        if (!includePrerelease && isPrereleaseNugetVersion(version.version)) return false;
        if (!includeSemVer2 && (metadata.semVer2 ?? isSemVer2NugetVersion(version.version))) {
          return false;
        }
        return true;
      });
      if (versions.length === 0) continue;
      const latest = versions.at(-1)!;
      const latestMetadata = latest.metadata as unknown as NugetVersionMeta;
      const lower = pkg.name.toLowerCase();
      data.push({
        id: latestMetadata.displayId ?? pkg.name,
        version: latest.version,
        versions: versions.map((v) => ({
          version: v.version,
          downloads: 0,
          "@id": `${base}/v3/registrations/${lower}/${v.version}.json`,
        })),
        packageTypes: [],
        registration: `${base}/v3/registrations/${lower}/index.json`,
        totalDownloads: 0,
      });
    }
    return Response.json({ totalHits: data.length, data: data.slice(skip, skip + take) });
  }

  private async download(
    id: string,
    version: string,
    file: string,
    ctx: RepoContext,
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
    ctx: RepoContext,
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
    await ctx.db
      .update(packageVersions)
      .set({ metadata: { ...metadata, listed } })
      .where(eq(packageVersions.id, row.id));
    return new Response(null, { status: listed ? 200 : 204 });
  }

  private async publish(req: Request, ctx: RepoContext): Promise<Response> {
    const url = new URL(req.url);
    const query = parseRegistryInput(
      NugetPublishQuerySchema,
      {
        id: url.searchParams.get("id") || undefined,
        version: url.searchParams.get("version") || undefined,
      },
      { code: "MANIFEST_INVALID", message: "invalid publish query" },
    );
    let id = query.id ?? "";
    let version = query.version ?? "";

    // Accept the raw .nupkg body or a multipart part (real `dotnet nuget push`
    // sends a positional file part, not a named "package" field).
    let bytes: Uint8Array;
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      parseRegistryInput(MultipartContentTypeSchema, ct, {
        code: "MANIFEST_INVALID",
        message: "invalid multipart content-type",
      });
      const body = new Uint8Array(await req.arrayBuffer());
      const file = extractMultipartFile(ct, body);
      if (!file) return Response.json({ error: "missing package" }, { status: 400 });
      bytes = file;
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
    }

    const meta = extractNuspecMeta(bytes);
    if (!meta) {
      return Response.json(
        { error: "could not determine package id and version" },
        { status: 400 },
      );
    }
    const metaId = parseRegistryInput(NugetIdSchema, meta.id, {
      code: "MANIFEST_INVALID",
      message: "invalid nuspec package id",
    });
    if (id && id.toLowerCase() !== metaId.toLowerCase()) {
      return Response.json({ error: "package id does not match nuspec" }, { status: 400 });
    }
    id = id || metaId;

    const normalizedMetaVersion = normalizeNugetVersion(meta.version);
    const normalizedQueryVersion = version ? normalizeNugetVersion(version) : normalizedMetaVersion;
    if (!normalizedMetaVersion || !normalizedQueryVersion) {
      return Response.json({ error: "invalid package version" }, { status: 400 });
    }
    if (normalizedQueryVersion !== normalizedMetaVersion) {
      return Response.json({ error: "package version does not match nuspec" }, { status: 400 });
    }
    version = normalizedMetaVersion;

    const lower = id.toLowerCase();
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: lower,
    });
    // NuGet packages are immutable. A retention tombstone still reserves the
    // normalized package version, so old bytes cannot be replaced by re-push.
    const existing = await findVersion(pkg.id, version);
    if (existing) return new Response(null, { status: 409 });

    const file = `${lower}.${version}.nupkg`;
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
        nupkgDigest: stored.digest,
        file,
        displayId: id,
        listed: true,
        semVer2: isSemVer2NugetVersion(meta.version),
        dependencyGroups: meta.dependencyGroups,
      },
      sizeBytes: bytes.length,
      scan: {
        name: lower,
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
