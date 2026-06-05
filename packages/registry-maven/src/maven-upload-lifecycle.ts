import type { RegistryRequestContext } from "@hootifactory/registry";
import { parsePomDependencies } from "./maven-pom";
import { contentTypeForPath, isPrimaryPom, parseMavenCoordinates } from "./maven-validation";

/** Blob/asset kind for stored Maven files; the scope is the repository path. */
export const MAVEN_FILE_KIND = "maven_file";

/**
 * Maven is a coordinate-addressed file store: every PUT (jar, pom, checksum,
 * maven-metadata.xml) is stored as a path-scoped asset. The primary `.pom`
 * additionally projects a package/version (with parsed deps) for listing + scan.
 */
export async function handleMavenUpload(
  path: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  const mediaType = contentTypeForPath(path);
  const stored = await ctx.data.content.storeBlobWithRef({
    data: bytes,
    kind: MAVEN_FILE_KIND,
    scope: path,
    mediaType,
  });
  await ctx.data.assets.upsert({
    digest: stored.digest,
    blobRefId: stored.blobRefId,
    role: MAVEN_FILE_KIND,
    scope: path,
    path,
    mediaType,
    sizeBytes: bytes.byteLength,
  });

  const coords = parseMavenCoordinates(path);
  if (coords && isPrimaryPom(coords)) {
    const name = `${coords.groupId}:${coords.artifactId}`;
    const pkg = await ctx.data.packages.findOrCreate({ name, namespace: coords.groupId });
    await ctx.data.versions.upsert({
      package: pkg,
      version: coords.version,
      metadata: {
        groupId: coords.groupId,
        artifactId: coords.artifactId,
        version: coords.version,
        deps: parsePomDependencies(new TextDecoder().decode(bytes)),
        pomDigest: stored.digest,
      },
      sizeBytes: bytes.byteLength,
    });
    await ctx.enqueueScan({
      digest: stored.digest,
      name,
      version: coords.version,
      mediaType: "application/xml",
    });
  }

  return new Response(null, { status: 201 });
}
