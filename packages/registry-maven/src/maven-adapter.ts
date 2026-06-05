import {
  asJsonRecord,
  basicAuthChallenge,
  delegateRegistryPlugin,
  Errors,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RouteMatch,
  readWritePermission,
  registryCapabilities,
  registryPlugin,
  serveRegistryBlob,
} from "@hootifactory/registry";
import { handleMavenUpload, MAVEN_FILE_KIND } from "./maven-upload-lifecycle";
import { contentTypeForPath, MavenPathSchema, mavenPackageForPath } from "./maven-validation";

/** Maven: a coordinate-addressed file store with POM-driven package projection. */
export class MavenAdapter implements RegistryPlugin {
  readonly id = "maven" as const;
  readonly capabilities = registryCapabilities("virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Maven",
      mountSegment: "maven",
      errorResponseKind: "singleError",
      compressibleHandlers: [],
      scan: {
        defaultOsvEcosystem: "Maven",
        dependencyGraph: ({ metadata }) => ({
          deps: mavenDependencyGraph(metadata),
          osvEcosystem: "Maven",
          purlType: "maven",
        }),
        referencedDigests: (metadata) =>
          typeof metadata.pomDigest === "string" ? [metadata.pomDigest] : [],
      },
    })
    .capabilities(this.capabilities)
    .authChallenge(this.authChallenge)
    .routes((route) => [
      route.put("/:path+", "upload", ({ params, req, ctx }) => this.upload(params.path, req, ctx)),
      route.get("/:path+", "download", ({ params, req, ctx }) =>
        this.download(params.path, req, ctx),
      ),
    ])
    .build();
  private readonly delegate = delegateRegistryPlugin(this.plugin);

  get displayName() {
    return this.plugin.displayName;
  }
  get mountSegment() {
    return this.plugin.mountSegment;
  }
  get repositoryNamePolicy() {
    return this.plugin.repositoryNamePolicy;
  }
  get acceptsRegistryBearerToken() {
    return this.plugin.acceptsRegistryBearerToken;
  }
  get apiKeyHeaders() {
    return this.plugin.apiKeyHeaders;
  }
  get errorResponseKind() {
    return this.plugin.errorResponseKind;
  }
  get compressibleHandlers() {
    return this.plugin.compressibleHandlers;
  }
  get compressibleContentTypes() {
    return this.plugin.compressibleContentTypes;
  }
  get scan() {
    return this.plugin.scan;
  }

  routes = this.delegate.routes;

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    const permission = readWritePermission(method);
    const path = match?.params.path;
    if (!path) return permission;
    const pkg = mavenPackageForPath(path);
    if (pkg) {
      return { ...permission, resource: { type: "package", packageName: pkg } };
    }
    return { ...permission, resource: { type: "artifact", artifactRef: path } };
  }

  handle = this.delegate.handle;

  private upload(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const safePath = parseRegistryInput(MavenPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid maven path",
    });
    return handleMavenUpload(safePath, req, ctx);
  }

  private async download(
    path: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const safePath = parseRegistryInput(MavenPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid maven path",
    });
    const asset = await ctx.data.assets.findByScope({ role: MAVEN_FILE_KIND, scope: safePath });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: MAVEN_FILE_KIND,
      scope: safePath,
      contentType: contentTypeForPath(safePath),
      redirect: req.method === "GET",
      blocked: () => new Response("artifact blocked by scan policy", { status: 403 }),
    });
  }
}

function mavenDependencyGraph(metadata: Record<string, unknown>): Record<string, string> {
  const deps = asJsonRecord(metadata.deps);
  if (!deps) return {};
  const out: Record<string, string> = {};
  for (const [name, constraint] of Object.entries(deps)) {
    if (typeof constraint === "string") out[name] = constraint;
  }
  return out;
}

export const mavenRegistryPlugin: RegistryPlugin = new MavenAdapter();
