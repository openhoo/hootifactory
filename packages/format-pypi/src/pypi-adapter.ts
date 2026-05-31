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
import { computeDigest, digestHex } from "@hootifactory/storage";
import { normalizeName, renderProjectHtml, renderRootHtml, type SimpleFile } from "./simple";

interface PypiFileMeta {
  filename: string;
  blobDigest: string;
  sha256: string;
  requiresPython?: string;
  size: number;
  filetype?: string;
}

export class PypiAdapter implements FormatAdapter {
  readonly format = "pypi" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/simple/", handlerId: "simpleRoot" },
      { method: "GET", pattern: "/simple/:project/", handlerId: "simpleProject" },
      { method: "GET", pattern: "/files/:filename", handlerId: "download" },
      { method: "POST", pattern: "/", handlerId: "upload" },
      { method: "POST", pattern: "/legacy/", handlerId: "upload" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
  }

  authChallenge() {
    return { header: 'Basic realm="hootifactory"', status: 401 as const };
  }

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    switch (match.entry.handlerId) {
      case "simpleRoot":
        return this.simpleRoot(ctx);
      case "simpleProject":
        return this.simpleProject(match.params.project ?? "", ctx);
      case "download":
        return this.download(match.params.filename ?? "", ctx);
      case "upload":
        return this.upload(req, ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async findPackage(ctx: RepoContext, name: string) {
    const [pkg] = await ctx.db
      .select()
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, name)))
      .limit(1);
    return pkg ?? null;
  }

  private async simpleRoot(ctx: RepoContext): Promise<Response> {
    const rows = await ctx.db
      .select({ name: packages.name })
      .from(packages)
      .where(eq(packages.repositoryId, ctx.repo.id));
    return new Response(renderRootHtml(rows.map((r) => r.name).sort()), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  /** All files across this repo's live (non-pruned) versions. */
  private async liveFiles(ctx: RepoContext, packageId?: string): Promise<PypiFileMeta[]> {
    const rows = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .innerJoin(packages, eq(packageVersions.packageId, packages.id))
      .where(
        and(
          packageId
            ? eq(packageVersions.packageId, packageId)
            : eq(packages.repositoryId, ctx.repo.id),
          isNull(packageVersions.deletedAt),
        ),
      );
    return rows.flatMap((r) => (r.metadata as { files?: PypiFileMeta[] })?.files ?? []);
  }

  private async simpleProject(projectRaw: string, ctx: RepoContext): Promise<Response> {
    const name = normalizeName(projectRaw);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    // Live versions only — pruned releases must drop out of the PEP 503 index.
    const versions = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)));
    const files: SimpleFile[] = [];
    for (const v of versions) {
      const fileList = (v.metadata as { files?: PypiFileMeta[] })?.files ?? [];
      for (const f of fileList) {
        files.push({
          filename: f.filename,
          url: `${ctx.baseUrl}/${ctx.repo.mountPath}/files/${f.filename}`,
          sha256: f.sha256,
          requiresPython: f.requiresPython,
        });
      }
    }
    return new Response(renderProjectHtml(name, files), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  private async download(filename: string, ctx: RepoContext): Promise<Response> {
    // Resolve the digest from the SAME metadata the simple index advertises (live
    // versions only), so the bytes served match the published #sha256 and identical
    // filenames from different packages don't collide via a blob_refs scan.
    const file = (await this.liveFiles(ctx)).find((f) => f.filename === filename);
    if (!file || !(await ctx.blobs.exists(file.blobDigest))) {
      return new Response("Not Found", { status: 404 });
    }
    if (await isArtifactBlocked(ctx, file.blobDigest)) {
      return new Response("artifact blocked by scan policy", { status: 403 });
    }
    return new Response(ctx.blobs.get(file.blobDigest), {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private async upload(req: Request, ctx: RepoContext): Promise<Response> {
    const form = await req.formData();
    const content = form.get("content");
    if (!(content instanceof File)) {
      return Response.json({ error: "missing file content" }, { status: 400 });
    }
    const rawName = String(form.get("name") ?? "");
    const version = String(form.get("version") ?? "");
    if (!rawName || !version) {
      return Response.json({ error: "missing name or version" }, { status: 400 });
    }
    const name = normalizeName(rawName);
    const bytes = new Uint8Array(await content.arrayBuffer());
    const filename = content.name;

    // PyPI files are immutable: reject a re-upload of an existing filename.
    if ((await this.liveFiles(ctx)).some((f) => f.filename === filename)) {
      return Response.json({ message: "File already exists." }, { status: 409 });
    }
    // Validate the client-declared sha256 against the actual bytes before storing.
    const claimed = form.get("sha256_digest");
    const actualSha = digestHex(computeDigest(bytes));
    if (claimed && String(claimed).toLowerCase() !== actualSha) {
      return Response.json(
        { message: "sha256_digest does not match uploaded content" },
        { status: 400 },
      );
    }
    const requiresPython = form.get("requires_python")
      ? String(form.get("requires_python"))
      : undefined;
    const filetype = form.get("filetype") ? String(form.get("filetype")) : undefined;

    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name,
    });
    const stored = await storeBlobWithRef(ctx, {
      data: bytes,
      kind: "pypi_file",
      scope: filename,
      mediaType: "application/octet-stream",
    });
    const fileMeta: PypiFileMeta = {
      filename,
      blobDigest: stored.digest,
      sha256: digestHex(stored.digest),
      requiresPython,
      size: bytes.length,
      filetype,
    };

    const existing = await findVersion(pkg.id, version);
    const existingFiles =
      (existing?.metadata as { files?: PypiFileMeta[] } | undefined)?.files ?? [];
    const files = [...existingFiles.filter((f) => f.filename !== filename), fileMeta];

    await upsertPackageVersion(ctx, {
      packageId: pkg.id,
      version,
      metadata: { name: rawName, requiresPython, files },
      sizeBytes: bytes.length,
    });

    await ctx.enqueueScan({
      digest: stored.digest,
      name,
      version,
      mediaType: filetype === "bdist_wheel" ? "application/zip" : "application/x-tar",
    });

    return new Response(null, { status: 200 });
  }
}
