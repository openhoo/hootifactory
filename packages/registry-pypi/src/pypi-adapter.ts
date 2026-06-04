import {
  basicAuthChallenge,
  delegateRegistryPlugin,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPackageHandle,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
} from "@hootifactory/registry";
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
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.format)
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.get("/simple/", "simpleRoot", ({ req, ctx }) => this.simpleRoot(req, ctx)),
      route.get("/simple/:project/", "simpleProject", ({ params, req, ctx }) =>
        this.simpleProject(params.project, req, ctx),
      ),
      route.get("/files/:filename", "download", ({ params, ctx }) =>
        this.download(params.filename, ctx),
      ),
      route.post("/", "upload", ({ req, ctx }) => this.upload(req, ctx)),
      route.post("/legacy/", "upload", ({ req, ctx }) => this.upload(req, ctx)),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const project = match?.params.project;
    const filename = match?.params.filename;
    if (filename) {
      return { ...permission, resource: { type: "artifact", artifactRef: filename } };
    }
    if (project) {
      return { ...permission, resource: { type: "package", packageName: normalizeName(project) } };
    }
    return permission;
  }

  handle = this.delegate.handle;

  private redirectToSlash(req: Request): Response | null {
    if (new URL(req.url).pathname.endsWith("/")) return null;
    const url = new URL(req.url);
    url.pathname = `${url.pathname}/`;
    return new Response(null, { status: 308, headers: { location: url.toString() } });
  }

  private async simpleRoot(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const redirect = this.redirectToSlash(req);
    if (redirect) return redirect;

    const rows = await ctx.data.packages.listNames();
    const projects = rows.map((r) => r.name);
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
    pkg?: RegistryPackageHandle,
  ): Promise<PypiFileMeta[]> {
    const rows = await ctx.data.versions.listRepositoryMetadata({ package: pkg, liveOnly: true });
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
    const pkg = await ctx.data.packages.findByName(name);
    if (!pkg) return new Response("Not Found", { status: 404 });
    // Live versions only — pruned releases must drop out of the PEP 503 index.
    const versions = await ctx.data.versions.listLive(pkg);
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
    if (!file) {
      return new Response("Not Found", { status: 404 });
    }
    return serveRegistryBlob(ctx, {
      digest: file.blobDigest,
      kind: "pypi_file",
      scope: file.filename,
      contentType: "application/octet-stream",
      blocked: () => new Response("artifact blocked by scan policy", { status: 403 }),
    });
  }

  private async upload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handlePypiUpload(req, ctx);
  }
}

export const pypiRegistryPlugin: RegistryPlugin = new PypiAdapter();
