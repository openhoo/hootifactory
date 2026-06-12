import {
  asJsonRecord,
  type RegistryPlugin,
  type RegistryRequestContext,
  type RegistryRouteParamSpec,
  registryAdapter,
  serveAssetBlob,
} from "@hootifactory/registry";
import { handleMavenUpload, MAVEN_FILE_KIND } from "./maven-upload-lifecycle";
import { contentTypeForPath, MavenPathSchema, mavenPackageForPath } from "./maven-validation";

const pathParam: RegistryRouteParamSpec = {
  schema: MavenPathSchema,
  code: "NAME_INVALID",
  message: "invalid maven path",
};

/** Maven: a coordinate-addressed file store with POM-driven package projection. */
class MavenAdapterState {
  upload(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return handleMavenUpload(path, req, ctx);
  }

  async download(path: string, req: Request, ctx: RegistryRequestContext): Promise<Response> {
    return serveAssetBlob(ctx, {
      role: MAVEN_FILE_KIND,
      kind: MAVEN_FILE_KIND,
      scope: path,
      contentType: contentTypeForPath(path),
      redirect: req.method === "GET",
    });
  }
}

/** CAS blob digests a version owns: the POM plus every content-bearing binary. */
function mavenReferencedDigests(metadata: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (typeof metadata.pomDigest === "string") out.add(metadata.pomDigest);
  if (Array.isArray(metadata.binaryDigests)) {
    for (const d of metadata.binaryDigests) if (typeof d === "string") out.add(d);
  }
  return [...out];
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

const mavenDefinition = registryAdapter("maven")
  .stateClass(MavenAdapterState)
  .module((module) =>
    module
      .displayName("Maven")
      .mount("maven")
      .capabilities("virtualizable")
      .errorResponseKind("singleError")
      .compressibleHandlers(),
  )
  .scan((scan) =>
    scan
      .osvEcosystem("Maven")
      .purlType("maven")
      .dependencies(mavenDependencyGraph)
      .referencedDigests((metadata) => mavenReferencedDigests(metadata)),
  )
  .basicAuth()
  .permissions((p) =>
    p.byParams([
      p.packageRule({ param: "path", normalize: (path) => mavenPackageForPath(path) }),
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

export class MavenAdapter extends mavenDefinition.adapterClass() {}
export const mavenRegistryPlugin: RegistryPlugin = new MavenAdapter();
