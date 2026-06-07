import {
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryAdapter,
  serveRegistryBlob,
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

interface SimpleRootCacheEntry {
  body: string;
  etag: string;
  expiresAt: number;
}

class PypiAdapterState {
  readonly simpleRootCache = new Map<string, SimpleRootCacheEntry>();

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

  simpleRootCacheKey(ctx: RegistryRequestContext, variant: SimpleRootVariant): string {
    return `${ctx.repo.id}:${variant}`;
  }

  cachedSimpleRoot(
    ctx: RegistryRequestContext,
    variant: SimpleRootVariant,
  ): SimpleRootCacheEntry | null {
    const entry = this.simpleRootCache.get(this.simpleRootCacheKey(ctx, variant));
    if (!entry) return null;
    if (entry.expiresAt > Date.now()) return entry;
    this.simpleRootCache.delete(this.simpleRootCacheKey(ctx, variant));
    return null;
  }

  storeSimpleRoot(
    ctx: RegistryRequestContext,
    variant: SimpleRootVariant,
    body: string,
  ): SimpleRootCacheEntry {
    const entry = {
      body,
      etag: textEtag(body),
      expiresAt: Date.now() + SIMPLE_ROOT_CACHE_TTL_MS,
    };
    this.simpleRootCache.set(this.simpleRootCacheKey(ctx, variant), entry);
    return entry;
  }

  clearSimpleRootCache(ctx: RegistryRequestContext): void {
    this.simpleRootCache.delete(this.simpleRootCacheKey(ctx, "html"));
    this.simpleRootCache.delete(this.simpleRootCacheKey(ctx, "json"));
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
    const cached = this.cachedSimpleRoot(ctx, variant);
    if (cached) {
      return textResponseWithEtag(
        req,
        cached.body,
        this.simpleRootHeaders(req, variant),
        cached.etag,
      );
    }

    const rows = await ctx.data.packages.listNames();
    const projects = rows.map((r) => r.name);
    if (variant === "json") {
      const entry = this.storeSimpleRoot(
        ctx,
        variant,
        JSON.stringify(buildSimpleRootJson(projects)),
      );
      return textResponseWithEtag(
        req,
        entry.body,
        this.simpleRootHeaders(req, variant),
        entry.etag,
      );
    }
    const entry = this.storeSimpleRoot(ctx, variant, renderRootHtml(projects));
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
    if (!pkg) return new Response("Not Found", { status: 404 });
    // Live versions only — pruned releases must drop out of the PEP 503 index.
    const versions = await ctx.data.versions.listLive(pkg);
    const files = buildSimpleProjectFiles(versions, {
      baseUrl: ctx.baseUrl,
      mountPath: ctx.repo.mountPath,
    });
    if (preferredSimpleResponse(req.headers.get("accept")) === "json") {
      return textResponseWithEtag(
        req,
        JSON.stringify(buildSimpleProjectJson(name, versions, files)),
        {
          "content-type": SIMPLE_JSON_CONTENT_TYPE,
        },
      );
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
    const file = await ctx.data.assets.findByScope({ role: "pypi_file", scope: filename });
    if (!file) {
      return new Response("Not Found", { status: 404 });
    }
    return serveRegistryBlob(ctx, {
      digest: file.digest,
      kind: "pypi_file",
      scope: file.scope,
      contentType: "application/octet-stream",
      redirect: req.method === "GET",
      blocked: () => new Response("artifact blocked by scan policy", { status: 403 }),
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
  .fromState((state) => state.defaultPermission("requiredPermission"))
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
