import { computeDigest, digestHex, type RegistryRequestContext } from "@hootifactory/registry";
import {
  buildGenericVersionMeta,
  GENERIC_VERSION,
  type GenericVersionMeta,
  genericBlobScope,
  normalizeGenericContentType,
  parseGenericVersionMeta,
} from "./generic-validation";

const GENERIC_BLOB_KIND = "generic_blob";
const GENERIC_ASSET_ROLE = "generic_blob";

/** Compute the sha512 sidecar hex of an in-memory blob. */
export function sha512Hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(data);
  return hasher.digest("hex");
}

/**
 * Compute the md5 sidecar hex of an in-memory blob. Raw-store clients and the
 * artifact hosts this format interoperates with (Artifactory/Nexus) surface and
 * verify against an md5 checksum, so we persist and serve it alongside sha256.
 */
export function md5Hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(data);
  return hasher.digest("hex");
}

export interface GenericStoreResult {
  path: string;
  meta: GenericVersionMeta;
  created: boolean;
}

/**
 * Upload a raw blob at `path`. Paths are *mutable* addresses, so a re-`PUT`
 * overwrites the live blob: we look up the existing live version, pass its blob
 * digest as `previousDigest` so the old CAS ref is released, and upsert the
 * single `current` version (with the derived sha256/sha512 metadata) that the
 * read route + index resolve against.
 */
export async function handleGenericStore(
  path: string,
  data: Uint8Array,
  contentType: string | null,
  ctx: RegistryRequestContext,
): Promise<GenericStoreResult> {
  const scope = genericBlobScope(path);
  const mediaType = normalizeGenericContentType(contentType);

  // The content hashes are derived from the bytes, so we can compute them up
  // front and assert the store agrees on the sha256 digest below.
  const blobDigest = computeDigest(data);
  const md5 = md5Hex(data);
  const sha256 = digestHex(blobDigest);
  const sha512 = sha512Hex(data);
  const meta = buildGenericVersionMeta({
    path,
    blobDigest,
    md5,
    sha256,
    sha512,
    size: data.length,
    contentType: mediaType,
  });

  // `path` is the package name; `current` is the single live version.
  const pkg = await ctx.data.packages.findOrCreate({ name: path });
  const existing = await ctx.data.versions.findLive(pkg, GENERIC_VERSION);
  const previousMeta = existing ? parseGenericVersionMeta(existing.metadata) : null;
  const previousDigest = previousMeta?.blobDigest ?? null;

  const { stored } = await ctx.data.versions.upsertWithBlobRef({
    package: pkg,
    version: GENERIC_VERSION,
    metadata: meta,
    sizeBytes: data.length,
    blob: {
      data,
      kind: GENERIC_BLOB_KIND,
      scope,
      mediaType,
      previousDigest,
      asset: {
        role: GENERIC_ASSET_ROLE,
        scope,
        path,
        mediaType,
        metadata: { path, md5, sha256, sha512 },
      },
    },
  });
  if (stored.digest !== blobDigest) {
    throw new Error("stored generic blob digest mismatch");
  }

  await ctx.enqueueScan({
    digest: stored.digest,
    name: path,
    version: GENERIC_VERSION,
    mediaType,
  });

  return { path, meta, created: existing === null };
}
