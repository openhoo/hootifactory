import {
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
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  computeChecksumHex,
  handleIvyUpload,
  IVY_FILE_KIND,
  ivyReferencedDigests,
  readIvyBlobBytes,
} from "./ivy-upload-lifecycle";
import {
  contentTypeForPath,
  IvyPathSchema,
  ivyPackageForPath,
  parseChecksumPath,
} from "./ivy-validation";

/**
 * Ivy repository (the layout SBT publishes/resolves against). A path-addressed
 * file store keyed by `[organisation]/[module]/[revision]/<file>`: the
 * `ivy-<revision>.xml` module descriptor plus the artifacts (jars, sources, poms).
 * `.sha1`/`.md5` checksum sidecars are served by hashing the stored base blob, so a
 * served checksum always matches the bytes the registry actually returns.
 */
export class IvyAdapter implements RegistryPlugin {
  readonly id = "ivy" as const;
  readonly capabilities = registryCapabilities("proxyable", "virtualizable");
  authChallenge = basicAuthChallenge;

  private readonly plugin = registryPlugin(this.id)
    .module({
      displayName: "Ivy",
      mountSegment: "ivy",
      errorResponseKind: "singleError",
      compressibleHandlers: [],
      scan: {
        defaultOsvEcosystem: "Maven",
        referencedDigests: (metadata) => ivyReferencedDigests(metadata),
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
    // Checksum sidecars authorize against the package of the file they cover.
    const checksum = parseChecksumPath(path);
    const pkg = ivyPackageForPath(checksum?.base ?? path);
    if (pkg) {
      return { ...permission, resource: { type: "package", packageName: pkg } };
    }
    return { ...permission, resource: { type: "artifact", artifactRef: path } };
  }

  handle = this.delegate.handle;

  private upload(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const safePath = parseRegistryInput(IvyPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid ivy path",
    });
    return handleIvyUpload(safePath, req, ctx);
  }

  private async download(
    path: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const safePath = parseRegistryInput(IvyPathSchema, path, {
      code: "NAME_INVALID",
      message: "invalid ivy path",
    });
    const checksum = parseChecksumPath(safePath);
    if (checksum) return this.downloadChecksum(checksum.base, checksum.algorithm, req, ctx);
    return this.downloadFile(safePath, req, ctx);
  }

  /** Serve a stored Ivy file (descriptor or artifact) via its path-scoped asset. */
  private async downloadFile(
    path: string,
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const asset = await ctx.data.assets.findByScope({ role: IVY_FILE_KIND, scope: path });
    if (!asset) throw Errors.notFound();
    return serveRegistryBlob(ctx, {
      digest: asset.digest,
      kind: IVY_FILE_KIND,
      scope: path,
      contentType: contentTypeForPath(path),
      redirect: req.method === "GET",
      blocked: () => new Response("artifact blocked by scan policy", { status: 403 }),
    });
  }

  /**
   * Serve a `.sha1`/`.md5` sidecar computed from the stored base file's bytes, so
   * the checksum is always consistent with the served artifact (SBT verifies it
   * against the file it just downloaded).
   */
  private async downloadChecksum(
    basePath: string,
    algorithm: "sha1" | "md5",
    req: Request,
    ctx: RegistryRequestContext,
  ): Promise<Response> {
    const bytes = await readIvyBlobBytes(ctx, basePath);
    if (!bytes) throw Errors.notFound();
    const checksum = computeChecksumHex(bytes, algorithm);
    return textResponseWithEtag(req, checksum, { "content-type": "text/plain; charset=utf-8" });
  }
}

export const ivyRegistryPlugin: RegistryPlugin = new IvyAdapter();
