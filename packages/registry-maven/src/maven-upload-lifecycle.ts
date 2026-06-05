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
  const mediaType = contentTypeForPath(path);
  const coords = parseMavenCoordinates(path);
  const primaryPom = coords && isPrimaryPom(coords) ? coords : null;

  if (!primaryPom) {
    if (!req.body) return new Response("empty request body", { status: 400 });
    const stored = await ctx.data.content.storeBlobStreamWithRef({
      data: req.body,
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
      sizeBytes: stored.size,
    });
    return new Response(null, { status: 201 });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
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

  if (primaryPom) {
    const name = `${primaryPom.groupId}:${primaryPom.artifactId}`;
    const pkg = await ctx.data.packages.findOrCreate({ name, namespace: primaryPom.groupId });
    await ctx.data.versions.upsert({
      package: pkg,
      version: primaryPom.version,
      metadata: {
        groupId: primaryPom.groupId,
        artifactId: primaryPom.artifactId,
        version: primaryPom.version,
        deps: parsePomDependencies(new TextDecoder().decode(bytes)),
        pomDigest: stored.digest,
      },
      sizeBytes: bytes.byteLength,
    });
    await ctx.enqueueScan({
      digest: stored.digest,
      name,
      version: primaryPom.version,
      mediaType: "application/xml",
    });
  }

  return new Response(null, { status: 201 });
}
