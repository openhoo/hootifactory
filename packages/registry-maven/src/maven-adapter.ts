import {
  asJsonRecord,
  createRegistryAdapterPlugin,
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

  async download(path: string, _req: Request, ctx: RegistryRequestContext): Promise<Response> {
    if (path.endsWith("/maven-metadata.xml")) {
      const generated = await generateMavenMetadataResponse(path, ctx);
      if (generated) return generated;
    }
    return serveAssetBlob(ctx, {
      role: MAVEN_FILE_KIND,
      kind: MAVEN_FILE_KIND,
      scope: path,
      contentType: contentTypeForPath(path),
    });
  }
}

/**
 * Parse the artifact-level groupId and artifactId out of a maven-metadata.xml
 * path. The second-to-last segment is the artifactId and everything before it
 * (joined with dots) is the groupId.  Returns null for paths that can't carry a
 * valid group + artifact pair (e.g. group-level metadata or too-short paths).
 */
function parseMavenMetadataPath(path: string): { groupId: string; artifactId: string } | null {
  const segments = path.split("/");
  if (segments.length < 3) return null;
  const artifactId = segments[segments.length - 2]!;
  const groupId = segments.slice(0, segments.length - 2).join(".");
  if (!groupId || !artifactId) return null;
  return { groupId, artifactId };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatMavenTimestamp(date: Date): string {
  const y = date.getUTCFullYear().toString();
  const M = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const m = date.getUTCMinutes().toString().padStart(2, "0");
  const s = date.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${M}${d}${h}${m}${s}`;
}

function buildMavenMetadataXml(params: {
  groupId: string;
  artifactId: string;
  latest: string;
  release: string;
  versions: string[];
  lastUpdated: string;
}): string {
  const versionsXml = params.versions
    .map((v) => `      <version>${escapeXml(v)}</version>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>${escapeXml(params.groupId)}</groupId>
  <artifactId>${escapeXml(params.artifactId)}</artifactId>
  <versioning>
    <latest>${escapeXml(params.latest)}</latest>
    <release>${escapeXml(params.release)}</release>
    <versions>
${versionsXml}
    </versions>
    <lastUpdated>${params.lastUpdated}</lastUpdated>
  </versioning>
</metadata>
`;
}

/**
 * Try to generate maven-metadata.xml server-side from the projected version
 * rows for the package this metadata path belongs to.  Returns `null` when the
 * package is unknown so the caller can fall back to the stored blob.
 */
async function generateMavenMetadataResponse(
  path: string,
  ctx: RegistryRequestContext,
): Promise<Response | null> {
  const coords = parseMavenMetadataPath(path);
  if (!coords) return null;
  const name = `${coords.groupId}:${coords.artifactId}`;
  const pkg = await ctx.data.packages.findByName(name);
  if (!pkg) return null;
  const versionNames = await ctx.data.versions.listLiveNames(pkg, { orderByCreated: "desc" });
  const versions = versionNames.map((v) => v.version);
  const latest = versions[0] ?? "";
  const release = versions.find((v) => !v.toUpperCase().includes("SNAPSHOT")) ?? "";
  const xml = buildMavenMetadataXml({
    groupId: coords.groupId,
    artifactId: coords.artifactId,
    latest,
    release,
    versions,
    lastUpdated: formatMavenTimestamp(new Date()),
  });
  return new Response(xml, { headers: { "content-type": "application/xml" } });
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
export const mavenRegistryPlugin = createRegistryAdapterPlugin(MavenAdapter);
