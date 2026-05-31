import {
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import { and, asc, eq, packages, packageVersions } from "@hootifactory/db";

interface NugetVersionMeta {
  nupkgDigest: string;
  file: string;
}

/**
 * NuGet v3. The consumption surface (service index + flat container) is
 * spec-compliant. Push accepts the .nupkg via PUT with id+version query params
 * (pragmatic for environments without the dotnet CLI; nuspec auto-extraction
 * is a follow-up).
 */
export class NugetAdapter implements FormatAdapter {
  readonly format = "nuget" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/v3/index.json", handlerId: "serviceIndex" },
      { method: "PUT", pattern: "/v3/package", handlerId: "publish" },
      { method: "GET", pattern: "/v3-flatcontainer/:id/index.json", handlerId: "versions" },
      { method: "GET", pattern: "/v3-flatcontainer/:id/:version/:file", handlerId: "download" },
      { method: "GET", pattern: "/v3/registrations/:id/index.json", handlerId: "registration" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
  }

  authChallenge() {
    return { header: 'Basic realm="hootifactory"', status: 401 as const };
  }

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
          ],
        });
      case "publish":
        return this.publish(req, ctx);
      case "versions":
        return this.versions(match.params.id ?? "", ctx);
      case "download":
        return this.download(match.params.id ?? "", match.params.version ?? "", ctx);
      case "registration":
        return this.registration(match.params.id ?? "", base, ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async findPkg(ctx: RepoContext, id: string) {
    const [pkg] = await ctx.db
      .select()
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, id.toLowerCase())))
      .limit(1);
    return pkg ?? null;
  }

  private async listVersions(ctx: RepoContext, packageId: string) {
    return ctx.db
      .select({ version: packageVersions.version, metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(asc(packageVersions.createdAt));
  }

  private async versions(id: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id);
    return Response.json({ versions: rows.map((r) => r.version) });
  }

  private async registration(id: string, base: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id);
    const items = rows.map((r) => ({
      "@type": "Package",
      catalogEntry: { id, version: r.version },
      packageContent: `${base}/v3-flatcontainer/${id.toLowerCase()}/${r.version}/${id.toLowerCase()}.${r.version}.nupkg`,
    }));
    return Response.json({ count: 1, items: [{ count: items.length, items }] });
  }

  private async download(id: string, version: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const [v] = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, version)))
      .limit(1);
    const digest = (v?.metadata as unknown as NugetVersionMeta | undefined)?.nupkgDigest;
    if (!digest || !(await ctx.blobs.exists(digest))) throw Errors.notFound();
    if (await isArtifactBlocked(ctx, digest)) {
      return new Response("blocked by scan policy", { status: 403 });
    }
    return new Response(ctx.blobs.get(digest), {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private async publish(req: Request, ctx: RepoContext): Promise<Response> {
    const url = new URL(req.url);
    const id = (url.searchParams.get("id") ?? "").trim();
    const version = (url.searchParams.get("version") ?? "").trim();
    if (!id || !version) {
      return Response.json({ error: "id and version query params required" }, { status: 400 });
    }
    // Accept the raw .nupkg body or a multipart "package" field.
    let bytes: Uint8Array;
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("package") ?? form.get("content");
      if (!(file instanceof File))
        return Response.json({ error: "missing package" }, { status: 400 });
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
    }
    const lower = id.toLowerCase();
    const file = `${lower}.${version}.nupkg`;
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: lower,
    });
    const stored = await storeBlobWithRef(ctx, {
      data: bytes,
      kind: "generic_file",
      scope: file,
      mediaType: "application/octet-stream",
    });
    await upsertPackageVersion(ctx, {
      packageId: pkg.id,
      version,
      metadata: { nupkgDigest: stored.digest, file, displayId: id },
      sizeBytes: bytes.length,
    });
    await ctx.enqueueScan({
      digest: stored.digest,
      name: lower,
      version,
      mediaType: "application/octet-stream",
    });
    return new Response(null, { status: 201 });
  }
}
