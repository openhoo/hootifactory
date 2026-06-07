import {
  commitPackageVersionBlob,
  findOrCreateRegistryPackage,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
  releaseRegistryBlobRef,
  storeRegistryBlobStreamWithRef,
} from "@hootifactory/registry";
import {
  buildNarInfoMeta,
  narFileHashFromUrl,
  type ParsedNarInfo,
  parseNarInfoText,
} from "./nix-validation";

export const NAR_BLOB_KIND = "nix_nar";
export const NARINFO_VERSION = "narinfo";

/** Content-addressable blob scope for a stored NAR, keyed by its bare file hash. */
export function narBlobScope(fileHash: string): string {
  return `nar/${fileHash}`;
}

/**
 * `PUT /nar/<filehash>.nar` — store the NAR blob content-addressably under a
 * scope derived from its file hash. Each store hash references a NAR by this
 * coordinate, so the blob is the canonical, dedupable artifact. We persist it
 * under the file hash as its own package so the blob survives even before its
 * narinfo arrives (clients upload the NAR first, then the narinfo).
 */
export async function handleNarUpload(
  fileHash: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  if (!req.body) {
    return new Response("missing NAR body", { status: 400 });
  }
  const scope = narBlobScope(fileHash);

  // Stream the NAR straight into content-addressable storage rather than
  // buffering the whole archive in memory — NARs can be gigabytes, so
  // `req.arrayBuffer()` would invite OOM and cap throughput. CAS computes the
  // digest and size as it consumes the stream.
  const stored = await storeRegistryBlobStreamWithRef(ctx, {
    data: req.body,
    kind: NAR_BLOB_KIND,
    scope,
    mediaType: "application/x-nix-nar",
  });

  const pkg = await findOrCreateRegistryPackage(ctx, { name: scope });
  const result = await commitPackageVersionBlob(ctx, {
    stored,
    package: pkg,
    version: NARINFO_VERSION,
    kind: NAR_BLOB_KIND,
    scope,
    metadata: { fileHash, blobDigest: stored.digest, sizeBytes: stored.size },
    sizeBytes: stored.size,
    scan: {
      name: scope,
      version: NARINFO_VERSION,
      mediaType: "application/x-nix-nar",
    },
    asset: {
      role: NAR_BLOB_KIND,
      scope,
      path: `${fileHash}.nar`,
      mediaType: "application/x-nix-nar",
      metadata: { fileHash, blobDigest: stored.digest },
    },
  });
  if ("conflict" in result) {
    // A version already holds this NAR. Release the ref we just created so the
    // freshly-streamed (deduped) blob isn't left orphaned.
    if (stored.refCreated) {
      await releaseRegistryBlobRef(ctx, { digest: stored.digest, kind: NAR_BLOB_KIND, scope });
    }
    return new Response("conflict", { status: 409 });
  }
  return new Response(null, { status: 200 });
}

/**
 * `PUT /<storehash>.narinfo` — persist the narinfo manifest keyed by store hash.
 * The NAR blob itself is uploaded separately; here we validate the body, confirm
 * its `StorePath` matches the requested hash, and store the metadata that the
 * read side reassembles into the served narinfo text.
 */
export async function handleNarInfoUpload(
  storeHash: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const body = await req.text();
  const parsed = parseNarInfoText(body);
  if (!parsed) {
    return new Response("invalid narinfo", { status: 400 });
  }
  if (!storePathMatchesHash(parsed.storePath, storeHash)) {
    return new Response("store path does not match hash", { status: 400 });
  }
  const narFileHash = narFileHashFromUrl(parsed.url);
  if (!narFileHash) {
    return new Response("narinfo URL is not a nar reference", { status: 400 });
  }

  const scope = narInfoScope(storeHash);
  const bodyBytes = new TextEncoder().encode(body);
  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: scope },
    version: NARINFO_VERSION,
    kind: NARINFO_KIND,
    scope,
    blob: {
      data: bodyBytes,
      kind: NARINFO_KIND,
      scope,
      mediaType: "text/x-nix-narinfo",
    },
    metadata: (stored) => buildNarInfoMeta(parsed, { digest: stored.digest, narFileHash }),
    sizeBytes: bodyBytes.length,
    scan: {
      name: scope,
      version: NARINFO_VERSION,
      mediaType: "text/x-nix-narinfo",
    },
    asset: (stored) => ({
      role: NARINFO_KIND,
      scope,
      path: `${storeHash}.narinfo`,
      mediaType: "text/x-nix-narinfo",
      metadata: { storeHash, narFileHash, blobDigest: stored.digest },
    }),
    // Narinfos are content-addressed by store hash; re-publishing is idempotent.
    versionConflict: () => Promise.resolve(false),
  });
  if (!result.ok) {
    return new Response("conflict", { status: 409 });
  }
  return new Response(null, { status: 204 });
}

export const NARINFO_KIND = "nix_narinfo";

/** Package scope under which a store hash's narinfo metadata is persisted. */
export function narInfoScope(storeHash: string): string {
  return `narinfo/${storeHash}`;
}

/** The narinfo `StorePath` must begin with the requested store hash. */
function storePathMatchesHash(storePath: string, storeHash: string): boolean {
  const prefix = `/nix/store/${storeHash}-`;
  return storePath.startsWith(prefix);
}

export type { ParsedNarInfo };
