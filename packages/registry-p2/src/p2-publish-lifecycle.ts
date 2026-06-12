import {
  publishImmutableVersionBlobMapped,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { parseOsgiManifest } from "./p2-osgi-manifest";
import { jarFilename, type P2ArtifactKind, type P2VersionMeta, p2JarScope } from "./p2-validation";

/** Blob/asset kind for stored P2 bundle/feature jars. */
export const P2_JAR_KIND = "p2_jar";

export interface P2PublishResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Publish a bundle/feature jar: parse its OSGi manifest (Bundle-SymbolicName +
 * Bundle-Version), store the jar as an immutable version blob keyed by the
 * symbolic name, and record the coordinates the download + index routes resolve
 * against. A re-publish of an existing (symbolicName, version) conflicts.
 */
export async function handleP2Publish(
  kind: P2ArtifactKind,
  req: Request,
  ctx: RegistryRequestContext,
  urlFilename?: string,
): Promise<P2PublishResult> {
  if (!req.body) {
    return { status: 400, body: { error: "empty request body" } };
  }
  const jar = new Uint8Array(await req.arrayBuffer());
  const manifest = parseOsgiManifest(jar);
  if (!manifest) {
    return {
      status: 422,
      body: { error: "jar is missing a parseable OSGi Bundle-SymbolicName manifest" },
    };
  }

  const { symbolicName, version } = manifest;
  const filename = jarFilename(symbolicName, version);

  if (urlFilename !== undefined && urlFilename !== filename) {
    return {
      status: 400,
      body: { error: `upload filename '${urlFilename}' does not match jar manifest '${filename}'` },
    };
  }

  const scope = p2JarScope(kind, filename);

  return publishImmutableVersionBlobMapped<P2PublishResult>(ctx, {
    package: { name: symbolicName },
    version,
    kind: P2_JAR_KIND,
    scope,
    blob: {
      data: jar,
      kind: P2_JAR_KIND,
      scope,
      mediaType: "application/java-archive",
    },
    metadata: (stored): P2VersionMeta & Record<string, unknown> => ({
      symbolicName,
      version,
      kind,
      filename,
      blobDigest: stored.digest,
      sizeBytes: jar.byteLength,
    }),
    sizeBytes: jar.byteLength,
    scan: {
      name: symbolicName,
      version,
      mediaType: "application/java-archive",
    },
    asset: (stored) => ({
      role: P2_JAR_KIND,
      scope,
      path: scope,
      mediaType: "application/java-archive",
      metadata: { symbolicName, version, kind, sha256: stored.digest },
    }),
    // P2 jars are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflict: () => ({ status: 409, body: { error: "version already exists" } }),
    success: () => ({
      status: 201,
      body: { ok: true, symbolicName, version, kind, filename },
    }),
  });
}
