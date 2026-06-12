import {
  Errors,
  jsonResponseWithEtag,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  registryAdapter,
  repoResponseCache,
  serveAssetBlob,
  textEtag,
  textResponseWithEtag,
} from "@hootifactory/registry";
import { handlePypiUpload } from "./pypi-upload-lifecycle";
import { PypiFilenameSchema, PypiProjectParamSchema } from "./pypi-validation";
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

const SIMPLE_ROOT_CACHE_TTL_MS = 5_000;
type SimpleRootVariant = "html" | "json";

class PypiAdapterState {
  readonly simpleRootCache = repoResponseCache<string>({ ttlMs: SIMPLE_ROOT_CACHE_TTL_MS });

  clearSimpleRootCache(ctx: RegistryRequestContext): void {
    this.simpleRootCache.clear(ctx);
  }

  redirectToSlash(req: Request): Response | null {
    if (new URL(req.url).pathname.endsWith("/")) return null;
    const url = new URL(req.url);
    url.pathname = `${url.pathname}/`;
    return new Response(null, { status: 308, headers: { location: url.toString() } });
  }

  async simpleRoot(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const redirect = this.redirectToSlash(req);
    if (redirect) return redirect;

    const variant = preferredSimpleResponse(req.headers.get("accept"));
    const entry = await this.simpleRootCache.get(ctx, variant, async () => {
      const rows = await ctx.data.packages.listNames();
      const projects = rows.map((r) => r.name);
      const body =
        variant === "json"
          ? JSON.stringify(buildSimpleRootJson(projects))
          : renderRootHtml(projects);
      return { body, etag: textEtag(body) };
    });
    return textResponseWithEtag(req, entry.body, this.simpleRootHeaders(req, variant), entry.etag);
  }

  simpleRootHeaders(req: Request, variant: SimpleRootVariant): Record<"content-type", string> {
    return {
      "content-type":
        variant === "json"
          ? SIMPLE_JSON_CONTENT_TYPE
          : simpleHtmlContentType(req.headers.get("accept")),
    };
  }

  async simpleProject(
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
    if (!pkg) throw Errors.notFound();
    // Live versions only — pruned releases must drop out of the PEP 503 index.
    const versions = await ctx.data.versions.listLive(pkg);
    const files = buildSimpleProjectFiles(versions, {
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    if (preferredSimpleResponse(req.headers.get("accept")) === "json") {
      return jsonResponseWithEtag(req, buildSimpleProjectJson(name, versions, files), {
        "content-type": SIMPLE_JSON_CONTENT_TYPE,
      });
    }
    return textResponseWithEtag(req, renderProjectHtml(name, files), {
      "content-type": simpleHtmlContentType(req.headers.get("accept")),
    });
  }

  async download(filename: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    filename = parseRegistryInput(PypiFilenameSchema, filename, {
      code: "NAME_INVALID",
      message: "invalid distribution filename",
    });
    return serveAssetBlob(ctx, {
      role: "pypi_file",
      kind: "pypi_file",
      scope: filename,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
    });
  }

  async upload(req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const res = await handlePypiUpload(req, ctx);
    if (res.status >= 200 && res.status < 300) this.clearSimpleRootCache(ctx);
    return res;
  }
}

const pypiDefinition = registryAdapter("pypi")
  .stateClass(PypiAdapterState)
  .module((module) =>
    module
      .displayName("PyPI")
      .mount("pypi")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers("simpleRoot", "simpleProject")
      .compressibleContentTypes("application/vnd.pypi.simple.v1+json"),
  )
  .scan((scan) =>
    scan.osvEcosystem("PyPI").referencedDigests((metadata) =>
      Array.isArray(metadata.files)
        ? metadata.files.flatMap((file) => {
            const blobDigest = (file as { blobDigest?: unknown } | null)?.blobDigest;
            return typeof blobDigest === "string" ? [blobDigest] : [];
          })
        : [],
    ),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.artifactRule({ param: "filename" }),
      p.packageRule({ param: "project", normalize: (project) => normalizeName(project) }),
    ]),
  )
  .routes((route) => [
    route.get("/simple/", "simpleRoot").calls((state, { req, ctx }) => state.simpleRoot(req, ctx)),
    route
      .get("/simple/:project/", "simpleProject")
      .calls((state, { params, req, ctx }) => state.simpleProject(params.project, req, ctx)),
    route
      .get("/files/:filename", "download")
      .calls((state, { params, req, ctx }) => state.download(params.filename, req, ctx)),
    route.post("/", "upload").calls((state, { req, ctx }) => state.upload(req, ctx)),
    route.post("/legacy/", "upload").calls((state, { req, ctx }) => state.upload(req, ctx)),
  ]);

export class PypiAdapter extends pypiDefinition.adapterClass() {}
export const pypiRegistryPlugin: RegistryPlugin = new PypiAdapter();
