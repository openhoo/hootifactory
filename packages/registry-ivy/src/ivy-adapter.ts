import {
  Errors,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  registryErrorResponseForModule,
  serveRegistryBlob,
  textResponseWithEtag,
} from "@hootifactory/registry";
import {
  handleIvyUpload,
  IVY_FILE_KIND,
  ivyReferencedDigests,
  streamIvyChecksumHex,
} from "./ivy-upload-lifecycle";
import {
  contentTypeForPath,
  IvyPathSchema,
  ivyPackageForPath,
  parseChecksumPath,
} from "./ivy-validation";

const IVY_ERROR_MODULE = { errorResponseKind: "singleError" as const };

const pathParam: RegistryRouteParamSpec = {
  schema: IvyPathSchema,
  code: "NAME_INVALID",
  message: "invalid ivy path",
};

/**
 * Ivy repository (the layout SBT publishes/resolves against). A path-addressed
 * file store keyed by `[organisation]/[module]/[revision]/<file>`: the
 * `ivy-<revision>.xml` module descriptor plus the artifacts (jars, sources, poms).
 * `.sha1`/`.md5` checksum sidecars are served by hashing the stored base blob, so a
 * served checksum always matches the bytes the registry actually returns.
 */
class IvyAdapterState {
  upload(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleIvyUpload(path, req, ctx, IVY_ERROR_MODULE);
  }

  async download(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    const checksum = parseChecksumPath(path);
    if (checksum) return this.downloadChecksum(checksum.base, checksum.algorithm, req, ctx);
    return this.downloadFile(path, req, ctx);
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
      blocked: () =>
        registryErrorResponseForModule(IVY_ERROR_MODULE, {
          status: 403,
          message: "artifact blocked by scan policy",
        }),
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
    const checksum = await streamIvyChecksumHex(ctx, basePath, algorithm);
    if (checksum === null) throw Errors.notFound();
    return textResponseWithEtag(req, checksum, { "content-type": "text/plain; charset=utf-8" });
  }
}

const ivyDefinition = registryAdapter("ivy")
  .stateClass(IvyAdapterState)
  .module((module) =>
    module
      .displayName("Ivy")
      .mount("ivy")
      // Virtualizable only: no proxyIngest/fetch-through is implemented.
      .capabilities("virtualizable")
      .errorResponseKind("singleError"),
  )
  .scan({
    defaultOsvEcosystem: "Maven",
    referencedDigests: (metadata) => ivyReferencedDigests(metadata),
  })
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.packageRule({
        param: "path",
        normalize: (path) => ivyPackageForPath(parseChecksumPath(path)?.base ?? path),
      }),
      p.artifactRule({ param: "path" }),
    ]),
  )
  .routes((route) => [
    route
      .put("/:path+", "upload")
      .params({ path: pathParam })
      .calls((state, { params, req, ctx }) => state.upload(params.path, req, ctx)),
    route
      .get("/:path+", "download")
      .params({ path: pathParam })
      .calls((state, { params, req, ctx }) => state.download(params.path, req, ctx)),
  ]);

export class IvyAdapter extends ivyDefinition.adapterClass() {}
export const ivyRegistryPlugin: RegistryPlugin = new IvyAdapter();
