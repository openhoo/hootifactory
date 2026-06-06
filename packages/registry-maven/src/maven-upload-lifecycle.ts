import { asJsonRecord, type RegistryRequestContext } from "@hootifactory/registry";
import { parsePomDependencies } from "./maven-pom";
import {
  contentTypeForPath,
  isPrimaryPom,
  isScannableMavenArtifact,
  type MavenCoordinates,
  parseMavenCoordinates,
} from "./maven-validation";

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
    // Scan the bytes that actually carry executable code (jar/war/ear/aar/.module);
    // checksum/signature sidecars (.sha1/.md5/.asc) and metadata files carry none.
    if (coords && isScannableMavenArtifact(path)) {
      const name = `${coords.groupId}:${coords.artifactId}`;
      await ctx.enqueueScan({
        digest: stored.digest,
        name,
        version: coords.version,
        mediaType,
      });
      await referenceBinaryDigest(ctx, coords, stored.digest);
    }
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

/**
 * Record a content-bearing binary's digest on its version metadata so retention
 * treats it as part of the version (the scan itself is always enqueued before
 * this, regardless of order). Maven uploads each file in its own PUT, so the
 * `.pom` version may not exist yet when the binary lands; in that case there is
 * no version row to annotate and the digest is simply not tracked for retention.
 */
async function referenceBinaryDigest(
  ctx: RegistryRequestContext,
  coords: MavenCoordinates,
  digest: string,
): Promise<void> {
  const name = `${coords.groupId}:${coords.artifactId}`;
  const pkg = await ctx.data.packages.findByName(name);
  if (!pkg) return;
  const row = await ctx.data.versions.find(pkg, coords.version);
  if (!row) return;
  const metadata = asJsonRecord(row.metadata) ?? {};
  await ctx.data.versions.updateMetadata(row, {
    ...metadata,
    binaryDigests: mergeBinaryDigest(metadata.binaryDigests, digest),
  });
}

/** Append `digest` to an existing (possibly malformed) binaryDigests list, deduped. */
function mergeBinaryDigest(existing: unknown, digest: string): string[] {
  const prior = Array.isArray(existing)
    ? existing.filter((d): d is string => typeof d === "string")
    : [];
  return [...new Set([...prior, digest])];
}
