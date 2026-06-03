import {
  basicAuthChallenge,
  digestHex,
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
  createPackageVersion,
  findOrCreatePackage,
  findPackageByName,
  findVersion,
  listLivePackageVersions,
  listRepositoryPackageNames,
  listRepositoryVersionMetadata,
  patchPackageVersion,
  releaseBlobRef,
  serveBlobIfClean,
  storeBlobWithRef,
} from "@hootifactory/registry-application";
import { parsePypiUploadRequest } from "./pypi-upload";
import {
  type AddPypiFileResult,
  normalizePypiVersionMetadata,
  type PypiFileMeta,
  PypiFilenameSchema,
  PypiProjectParamSchema,
} from "./pypi-validation";
import {
  buildSimpleProjectFiles,
  buildSimpleProjectJson,
  buildSimpleRootJson,
  normalizeName,
  preferredSimpleResponse,
  renderProjectHtml,
  renderRootHtml,
  SIMPLE_JSON_CONTENT_TYPE,
  simpleHtmlContentType,
} from "./simple";

export class PypiAdapter implements RegistryPlugin {
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
    return readWritePermission(method);
  }

  authChallenge = basicAuthChallenge;

  async handle(match: RouteMatch, req: Request, ctx: RegistryRequestContext): Promise<Response> {
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

  private redirectToSlash(req: Request): Response | null {
    if (new URL(req.url).pathname.endsWith("/")) return null;
    const url = new URL(req.url);
    url.pathname = `${url.pathname}/`;
    return new Response(null, { status: 308, headers: { location: url.toString() } });
  }

  private async simpleRoot(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const redirect = this.redirectToSlash(req);
    if (redirect) return redirect;

    const rows = await listRepositoryPackageNames(ctx);
    const projects = rows.map((r) => r.name).sort();
    if (preferredSimpleResponse(req.headers.get("accept")) === "json") {
      return Response.json(buildSimpleRootJson(projects), {
        headers: { "content-type": SIMPLE_JSON_CONTENT_TYPE },
      });
    }
    return new Response(renderRootHtml(projects), {
      headers: { "content-type": simpleHtmlContentType(req.headers.get("accept")) },
    });
  }

  /** All files across this repo's live (non-pruned) versions. */
  private async liveFiles(
    ctx: RegistryRequestContext,
    packageId?: string,
  ): Promise<PypiFileMeta[]> {
    const rows = await listRepositoryVersionMetadata(ctx, { packageId, liveOnly: true });
    return rows.flatMap((r) => (r.metadata as { files?: PypiFileMeta[] })?.files ?? []);
  }

  private async allFiles(ctx: RegistryRequestContext): Promise<PypiFileMeta[]> {
    const rows = await listRepositoryVersionMetadata(ctx, { liveOnly: false });
    return rows.flatMap((r) => (r.metadata as { files?: PypiFileMeta[] })?.files ?? []);
  }

  private async simpleProject(
    projectRaw: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const redirect = this.redirectToSlash(req);
    if (redirect) return redirect;

    projectRaw = parseRegistryInput(PypiProjectParamSchema, projectRaw, {
      code: "NAME_INVALID",
      message: "invalid project name",
    });
    const name = normalizeName(projectRaw);
    const pkg = await findPackageByName(ctx, name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    // Live versions only — pruned releases must drop out of the PEP 503 index.
    const versions = await listLivePackageVersions(pkg.id);
    const files = buildSimpleProjectFiles(versions, {
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    if (preferredSimpleResponse(req.headers.get("accept")) === "json") {
      return Response.json(buildSimpleProjectJson(name, versions, files), {
        headers: { "content-type": SIMPLE_JSON_CONTENT_TYPE },
      });
    }
    return new Response(renderProjectHtml(name, files), {
      headers: { "content-type": simpleHtmlContentType(req.headers.get("accept")) },
    });
  }

  private async download(filename: string, ctx: RegistryRequestContext): Promise<Response> {
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
    return serveBlobIfClean(ctx, {
      digest: file.blobDigest,
      contentType: "application/octet-stream",
      blocked: () => new Response("artifact blocked by scan policy", { status: 403 }),
    });
  }

  private async upload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const parsed = await parsePypiUploadRequest(req);
    if (!parsed.ok) return Response.json(parsed.error.body, { status: parsed.error.status });
    const { bytes, filename, filetype, name, rawName, requiresPython, version } = parsed.plan;

    // PyPI files are immutable: reject a re-upload of an existing filename,
    // including files hidden by retention.
    if ((await this.allFiles(ctx)).some((f) => f.filename === filename)) {
      return Response.json({ message: "File already exists." }, { status: 409 });
    }

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
    ctx: RegistryRequestContext,
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

    return patchPackageVersion<AddPypiFileResult>({
      packageId: opts.packageId,
      version: opts.version,
      patch: (row) => {
        if (!row?.id || row.deletedAt) {
          return { result: { ok: false, reason: "version_exists" as const } };
        }

        const metadata = normalizePypiVersionMetadata(row.metadata);
        if ((metadata.files ?? []).some((f) => f.filename === opts.fileMeta.filename)) {
          return { result: { ok: false, reason: "file_exists" as const } };
        }

        const files = [...(metadata.files ?? []), opts.fileMeta];
        return {
          update: {
            metadata: {
              ...metadata,
              name: metadata.name ?? opts.rawName,
              requiresPython: metadata.requiresPython ?? opts.requiresPython,
              files,
            },
            sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
          },
          result: { ok: true, versionId: row.id },
        };
      },
    });
  }
}
