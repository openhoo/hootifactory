import {
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  findVersion,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import { and, eq, isNull, packages, packageVersions } from "@hootifactory/db";
import { extractNuspecMeta } from "./nuspec";

interface NugetVersionMeta {
  nupkgDigest: string;
  file: string;
}

/** NuGet version normalization: drop a zero 4th segment + build metadata, lowercase prerelease. */
function normalizeNugetVersion(v: string): string {
  let s = v.trim();
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus); // strip build metadata
  const dash = s.indexOf("-");
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash).toLowerCase() : "";
  const nums = core.split(".").map((n) => String(Number.parseInt(n, 10) || 0));
  while (nums.length < 3) nums.push("0");
  if (nums.length === 4 && nums[3] === "0") nums.pop();
  return nums.join(".") + pre;
}

/** Compare two normalized NuGet versions (numeric core; a release outranks its prerelease). */
function compareNugetVersions(a: string, b: string): number {
  const split = (v: string) => {
    const d = v.indexOf("-");
    const core = (d >= 0 ? v.slice(0, d) : v).split(".").map(Number);
    return { core, pre: d >= 0 ? v.slice(d + 1) : null };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.core[i] ?? 0) !== (pb.core[i] ?? 0)) return (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
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
        return this.download(
          match.params.id ?? "",
          match.params.version ?? "",
          match.params.file ?? "",
          ctx,
        );
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
    const rows = await ctx.db
      .select({ version: packageVersions.version, metadata: packageVersions.metadata })
      .from(packageVersions)
      // Live versions only; sorted by SemVer so flat-container + registration bounds are correct.
      .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
    return rows.sort((a, b) => compareNugetVersions(a.version, b.version));
  }

  private async versions(id: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id);
    if (rows.length === 0) return new Response("Not Found", { status: 404 });
    return Response.json({ versions: rows.map((r) => r.version) });
  }

  private async registration(id: string, base: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) return new Response("Not Found", { status: 404 });
    const rows = await this.listVersions(ctx, pkg.id);
    const lower = id.toLowerCase();
    const registrationUrl = `${base}/v3/registrations/${lower}/index.json`;
    const items = rows.map((r) => {
      const leaf = `${base}/v3/registrations/${lower}/${r.version}.json`;
      const content = `${base}/v3-flatcontainer/${lower}/${r.version}/${lower}.${r.version}.nupkg`;
      return {
        "@id": leaf,
        "@type": "Package",
        catalogEntry: {
          "@id": leaf,
          "@type": "PackageDetails",
          id,
          version: r.version,
          listed: true,
          packageContent: content,
        },
        packageContent: content,
        registration: registrationUrl,
      };
    });
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

  private async download(
    id: string,
    version: string,
    file: string,
    ctx: RepoContext,
  ): Promise<Response> {
    const pkg = await this.findPkg(ctx, id);
    if (!pkg) throw Errors.notFound();
    const norm = normalizeNugetVersion(version);
    // The filename segment must match the canonical {id}.{version}.nupkg this server builds.
    const expected = `${id.toLowerCase()}.${norm}.nupkg`;
    if (file && file.toLowerCase() !== expected) throw Errors.notFound();
    const [v] = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, norm),
          isNull(packageVersions.deletedAt),
        ),
      )
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
    let id = (url.searchParams.get("id") ?? "").trim();
    let version = (url.searchParams.get("version") ?? "").trim();

    // Accept the raw .nupkg body or a multipart part (real `dotnet nuget push`
    // sends a positional file part, not a named "package" field).
    let bytes: Uint8Array;
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file =
        form.get("package") ??
        form.get("content") ??
        [...form.values()].find((v) => v instanceof File);
      if (!(file instanceof File))
        return Response.json({ error: "missing package" }, { status: 400 });
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
    }

    // Derive id/version from the .nupkg's nuspec when the client didn't pass them.
    if (!id || !version) {
      const meta = extractNuspecMeta(bytes);
      if (meta) {
        id = id || meta.id;
        version = version || meta.version;
      }
    }
    if (!id || !version) {
      return Response.json(
        { error: "could not determine package id and version" },
        { status: 400 },
      );
    }
    version = normalizeNugetVersion(version);

    const lower = id.toLowerCase();
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: lower,
    });
    // NuGet packages are immutable — a duplicate push is a 409 Conflict.
    const existing = await findVersion(pkg.id, version);
    if (existing && !existing.deletedAt) return new Response(null, { status: 409 });

    const file = `${lower}.${version}.nupkg`;
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
