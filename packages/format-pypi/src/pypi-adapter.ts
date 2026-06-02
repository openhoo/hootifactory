import {
  createPackageVersion,
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  findVersion,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  storeBlobWithRef,
} from "@hootifactory/core";
import { and, eq, isNull, packages, packageVersions } from "@hootifactory/db";
import { computeDigest, digestHex } from "@hootifactory/storage";
import {
  type AddPypiFileResult,
  filenameVersionMatches,
  normalizePypiVersionMetadata,
  type PypiFileMeta,
  PypiFilenameSchema,
  PypiProjectParamSchema,
  PypiUploadFieldsSchema,
  parsePypiFilename,
} from "./pypi-validation";
import { normalizeName, renderProjectHtml, renderRootHtml, type SimpleFile } from "./simple";

const SIMPLE_JSON_CONTENT_TYPE = "application/vnd.pypi.simple.v1+json";
const SIMPLE_HTML_CONTENT_TYPE = "application/vnd.pypi.simple.v1+html; charset=utf-8";
const LEGACY_HTML_CONTENT_TYPE = "text/html; charset=utf-8";

export class PypiAdapter implements FormatAdapter {
  readonly format = "pypi" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: false,
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
        return this.simpleRoot(req, ctx);
      case "simpleProject":
        return this.simpleProject(match.params.project ?? "", req, ctx);
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

  private redirectToSlash(req: Request): Response | null {
    if (new URL(req.url).pathname.endsWith("/")) return null;
    const url = new URL(req.url);
    url.pathname = `${url.pathname}/`;
    return new Response(null, { status: 308, headers: { location: url.toString() } });
  }

  private simpleContentType(req: Request): "json" | "html" {
    const accept = req.headers.get("accept") ?? "";
    const weighted = accept.split(",").map((part) => {
      const [media = "", ...params] = part.trim().split(";");
      const qParam = params.find((param) => param.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.split("=", 2)[1] ?? "0") : 1;
      return { media: media.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    });
    const jsonQ =
      weighted.find((part) => part.media === SIMPLE_JSON_CONTENT_TYPE)?.q ??
      weighted.find((part) => part.media === "application/json")?.q ??
      0;
    const htmlQ =
      Math.max(
        weighted.find((part) => part.media === "text/html")?.q ?? 0,
        weighted.find((part) => part.media === "application/vnd.pypi.simple.v1+html")?.q ?? 0,
        weighted.find((part) => part.media === "*/*")?.q ?? 0,
      ) || (accept ? 0 : 1);
    return jsonQ > 0 && jsonQ >= htmlQ ? "json" : "html";
  }

  private htmlContentType(req: Request): string {
    return (req.headers.get("accept") ?? "").toLowerCase().includes("application/vnd.pypi.simple")
      ? SIMPLE_HTML_CONTENT_TYPE
      : LEGACY_HTML_CONTENT_TYPE;
  }

  private async simpleRoot(req: Request, ctx: RepoContext): Promise<Response> {
    const redirect = this.redirectToSlash(req);
    if (redirect) return redirect;

    const rows = await ctx.db
      .select({ name: packages.name })
      .from(packages)
      .where(eq(packages.repositoryId, ctx.repo.id));
    const projects = rows.map((r) => r.name).sort();
    if (this.simpleContentType(req) === "json") {
      return Response.json(
        {
          meta: { "api-version": "1.1" },
          projects: projects.map((name) => ({ name })),
        },
        { headers: { "content-type": SIMPLE_JSON_CONTENT_TYPE } },
      );
    }
    return new Response(renderRootHtml(projects), {
      headers: { "content-type": this.htmlContentType(req) },
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

  private async allFiles(ctx: RepoContext): Promise<PypiFileMeta[]> {
    const rows = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .innerJoin(packages, eq(packageVersions.packageId, packages.id))
      .where(eq(packages.repositoryId, ctx.repo.id));
    return rows.flatMap((r) => (r.metadata as { files?: PypiFileMeta[] })?.files ?? []);
  }

  private async simpleProject(
    projectRaw: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    const redirect = this.redirectToSlash(req);
    if (redirect) return redirect;

    projectRaw = parseRegistryInput(PypiProjectParamSchema, projectRaw, {
      code: "NAME_INVALID",
      message: "invalid project name",
    });
    const name = normalizeName(projectRaw);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    // Live versions only — pruned releases must drop out of the PEP 503 index.
    const versions = await ctx.db
      .select({
        version: packageVersions.version,
        metadata: packageVersions.metadata,
        createdAt: packageVersions.createdAt,
      })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)));
    const files: SimpleFile[] = [];
    for (const v of versions) {
      const fileList = (v.metadata as { files?: PypiFileMeta[] })?.files ?? [];
      for (const f of fileList) {
        files.push({
          filename: f.filename,
          url: `${ctx.baseUrl}/${ctx.repo.mountPath}/files/${encodeURIComponent(f.filename)}`,
          sha256: f.sha256,
          requiresPython: f.requiresPython,
          size: f.size,
          uploadTime: v.createdAt.toISOString(),
        });
      }
    }
    if (this.simpleContentType(req) === "json") {
      return Response.json(
        {
          meta: { "api-version": "1.1" },
          name,
          versions: versions.map((v) => v.version).sort(),
          files: files.map((file) => ({
            filename: file.filename,
            url: file.url,
            hashes: { sha256: file.sha256 },
            ...(file.requiresPython ? { "requires-python": file.requiresPython } : {}),
            size: file.size,
            "upload-time": file.uploadTime,
          })),
        },
        { headers: { "content-type": SIMPLE_JSON_CONTENT_TYPE } },
      );
    }
    return new Response(renderProjectHtml(name, files), {
      headers: { "content-type": this.htmlContentType(req) },
    });
  }

  private async download(filename: string, ctx: RepoContext): Promise<Response> {
    filename = parseRegistryInput(PypiFilenameSchema, filename, {
      code: "NAME_INVALID",
      message: "invalid distribution filename",
    });
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
    const fields = parseRegistryInput(
      PypiUploadFieldsSchema,
      {
        name: form.get("name"),
        version: form.get("version"),
        sha256_digest: form.get("sha256_digest") || undefined,
        requires_python: form.get("requires_python") || undefined,
        filetype: form.get("filetype") || undefined,
      },
      { code: "MANIFEST_INVALID", message: "invalid upload metadata" },
    );
    const rawName = fields.name;
    const version = fields.version;
    const name = normalizeName(rawName);
    const bytes = new Uint8Array(await content.arrayBuffer());
    const filename = content.name;
    parseRegistryInput(PypiFilenameSchema, filename, {
      code: "NAME_INVALID",
      message: "invalid distribution filename",
    });
    const filenameIdentity = parsePypiFilename(filename);
    if (
      !filenameIdentity ||
      normalizeName(filenameIdentity.name) !== name ||
      !filenameVersionMatches(version, filenameIdentity.version)
    ) {
      return Response.json(
        { message: "filename does not match submitted package name and version" },
        { status: 400 },
      );
    }

    // PyPI files are immutable: reject a re-upload of an existing filename,
    // including files hidden by retention.
    if ((await this.allFiles(ctx)).some((f) => f.filename === filename)) {
      return Response.json({ message: "File already exists." }, { status: 409 });
    }
    // Validate the client-declared sha256 against the actual bytes before storing.
    const claimed = fields.sha256_digest;
    const actualSha = digestHex(computeDigest(bytes));
    if (claimed && claimed.toLowerCase() !== actualSha) {
      return Response.json(
        { message: "sha256_digest does not match uploaded content" },
        { status: 400 },
      );
    }
    const requiresPython = fields.requires_python;
    const filetype = fields.filetype;

    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name,
    });
    const existing = await findVersion(pkg.id, version);
    if (existing?.deletedAt) {
      return Response.json({ message: "Release version already exists." }, { status: 409 });
    }

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

    const added = await this.addFileToVersion(ctx, {
      packageId: pkg.id,
      version,
      rawName,
      requiresPython,
      fileMeta,
    });
    if (!added.ok) {
      if (stored.refCreated) {
        await releaseBlobRef(ctx, { digest: stored.digest, kind: "pypi_file", scope: filename });
      }
      return Response.json(
        {
          message:
            added.reason === "file_exists"
              ? "File already exists."
              : "Release version already exists.",
        },
        { status: 409 },
      );
    }

    await ctx.enqueueScan({
      digest: stored.digest,
      name,
      version,
      mediaType: filetype === "bdist_wheel" ? "application/zip" : "application/x-tar",
    });

    return new Response(null, { status: 200 });
  }

  private async addFileToVersion(
    ctx: RepoContext,
    opts: {
      packageId: string;
      version: string;
      rawName: string;
      requiresPython?: string;
      fileMeta: PypiFileMeta;
    },
  ): Promise<AddPypiFileResult> {
    const created = await createPackageVersion(ctx, {
      packageId: opts.packageId,
      version: opts.version,
      metadata: {
        name: opts.rawName,
        requiresPython: opts.requiresPython,
        files: [opts.fileMeta],
      },
      sizeBytes: opts.fileMeta.size,
    });
    if (created) return { ok: true, versionId: created };

    return ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: packageVersions.id,
          metadata: packageVersions.metadata,
          deletedAt: packageVersions.deletedAt,
        })
        .from(packageVersions)
        .where(
          and(
            eq(packageVersions.packageId, opts.packageId),
            eq(packageVersions.version, opts.version),
          ),
        )
        .for("update")
        .limit(1);
      if (!row?.id || row.deletedAt) return { ok: false, reason: "version_exists" as const };

      const metadata = normalizePypiVersionMetadata(row.metadata);
      if ((metadata.files ?? []).some((f) => f.filename === opts.fileMeta.filename)) {
        return { ok: false, reason: "file_exists" as const };
      }

      const files = [...(metadata.files ?? []), opts.fileMeta];
      await tx
        .update(packageVersions)
        .set({
          metadata: {
            ...metadata,
            name: metadata.name ?? opts.rawName,
            requiresPython: metadata.requiresPython ?? opts.requiresPython,
            files,
          },
          sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        })
        .where(eq(packageVersions.id, row.id));
      return { ok: true, versionId: row.id };
    });
  }
}
