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
  findPackageByName,
  listLivePackageVersions,
  listRepositoryPackageNames,
  listRepositoryVersionMetadata,
  serveBlobIfClean,
} from "@hootifactory/registry-application";
import { handlePypiUpload } from "./pypi-upload-lifecycle";
import {
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
    return rows.flatMap((r) => normalizePypiVersionMetadata(r.metadata).files ?? []);
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
    return handlePypiUpload(req, ctx);
  }
}
