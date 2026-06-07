import { asJsonRecord, type RegistryRequestContext } from "@hootifactory/registry";
import {
  contentTypeForPath,
  type IvyCoordinates,
  isIvyDescriptor,
  isScannableIvyArtifact,
  ivyPackageName,
  parseIvyCoordinates,
} from "./ivy-validation";

/** Blob/asset kind for stored Ivy files; the scope is the repository path. */
export const IVY_FILE_KIND = "ivy_file";

/**
 * Ivy is a path-addressed file store: every PUT (the `ivy-<rev>.xml` descriptor,
 * jars/sources/poms, and any `.sha1`/`.md5` sidecar) is stored as a path-scoped
 * asset. The descriptor additionally projects a package/version (`org#module` at
 * `revision`) so the module shows up in listings and scan/retention.
 */
export async function handleIvyUpload(
  path: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const mediaType = contentTypeForPath(path);
  const coords = parseIvyCoordinates(path);
  const descriptor = coords && isIvyDescriptor(coords) ? coords : null;

  if (!descriptor) {
    if (!req.body) return new Response("empty request body", { status: 400 });
    const stored = await ctx.data.content.storeBlobStreamWithRef({
      data: req.body,
      kind: IVY_FILE_KIND,
      scope: path,
      mediaType,
    });
    await ctx.data.assets.upsert({
      digest: stored.digest,
      blobRefId: stored.blobRefId,
      role: IVY_FILE_KIND,
      scope: path,
      path,
      mediaType,
      sizeBytes: stored.size,
    });
    // Only the executable artifacts (jar/war/ear/aar) carry scannable bytes;
    // checksum/signature sidecars and the descriptor carry none.
    if (coords && isScannableIvyArtifact(path)) {
      const name = ivyPackageName(coords.organisation, coords.module);
      await ctx.enqueueScan({
        digest: stored.digest,
        name,
        version: coords.revision,
        mediaType,
      });
      await referenceArtifactDigest(ctx, coords, stored.digest);
    }
    return new Response(null, { status: 201 });
  }

  // The descriptor is buffered so its package/version can be projected eagerly.
  const bytes = new Uint8Array(await req.arrayBuffer());
  const stored = await ctx.data.content.storeBlobWithRef({
    data: bytes,
    kind: IVY_FILE_KIND,
    scope: path,
    mediaType,
  });
  await ctx.data.assets.upsert({
    digest: stored.digest,
    blobRefId: stored.blobRefId,
    role: IVY_FILE_KIND,
    scope: path,
    path,
    mediaType,
    sizeBytes: bytes.byteLength,
  });

  const name = ivyPackageName(descriptor.organisation, descriptor.module);
  const pkg = await ctx.data.packages.findOrCreate({ name, namespace: descriptor.organisation });
  await ctx.data.versions.upsert({
    package: pkg,
    version: descriptor.revision,
    metadata: {
      organisation: descriptor.organisation,
      module: descriptor.module,
      revision: descriptor.revision,
      descriptorDigest: stored.digest,
    },
    sizeBytes: bytes.byteLength,
  });
  await ctx.enqueueScan({
    digest: stored.digest,
    name,
    version: descriptor.revision,
    mediaType: "application/xml",
  });

  return new Response(null, { status: 201 });
}

/**
 * Record a content-bearing artifact's digest on its version metadata so retention
 * treats it as part of the version. Ivy uploads each file in its own PUT, so the
 * descriptor's version may not exist yet when an artifact lands; in that case
 * there is no version row to annotate and the digest is simply not tracked.
 *
 * The append runs under a row-locked `patch` so concurrent artifact uploads to the
 * same revision can't clobber each other's digests, and a soft-deleted version is
 * left untouched.
 */
async function referenceArtifactDigest(
  ctx: RegistryRequestContext,
  coords: IvyCoordinates,
  digest: string,
): Promise<void> {
  const name = ivyPackageName(coords.organisation, coords.module);
  const pkg = await ctx.data.packages.findByName(name);
  if (!pkg) return;
  await ctx.data.versions.patch({
    package: pkg,
    version: coords.revision,
    patch: (row) => {
      if (!row || row.deletedAt) return { result: undefined };
      const metadata = asJsonRecord(row.metadata) ?? {};
      return {
        update: {
          metadata: {
            ...metadata,
            artifactDigests: mergeArtifactDigest(metadata.artifactDigests, digest),
          },
        },
        result: undefined,
      };
    },
  });
}

/** Append `digest` to an existing (possibly malformed) artifactDigests list, deduped. */
function mergeArtifactDigest(existing: unknown, digest: string): string[] {
  const prior = Array.isArray(existing)
    ? existing.filter((d): d is string => typeof d === "string")
    : [];
  return [...new Set([...prior, digest])];
}

/** CAS blob digests a version owns: the descriptor plus every content-bearing artifact. */
export function ivyReferencedDigests(metadata: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (typeof metadata.descriptorDigest === "string") out.add(metadata.descriptorDigest);
  if (Array.isArray(metadata.artifactDigests)) {
    for (const d of metadata.artifactDigests) if (typeof d === "string") out.add(d);
  }
  return [...out];
}

/** The checksum hex of `data` for a recognised algorithm. */
export function computeChecksumHex(data: Uint8Array, algorithm: "sha1" | "md5"): string {
  const hasher = new Bun.CryptoHasher(algorithm);
  hasher.update(data);
  return hasher.digest("hex");
}

/** Read the full bytes of a stored Ivy path's blob, or null when no asset exists. */
export async function readIvyBlobBytes(
  ctx: RegistryRequestContext,
  path: string,
): Promise<Uint8Array | null> {
  const asset = await ctx.data.assets.findByScope({ role: IVY_FILE_KIND, scope: path });
  if (!asset) return null;
  const blob = await ctx.data.content.getBlobRef({
    digest: asset.digest,
    kind: IVY_FILE_KIND,
    scope: path,
  });
  if (!blob) return null;
  return new Uint8Array(await new Response(blob.get()).arrayBuffer());
}
