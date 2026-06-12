import {
  commitPackageVersionBlob,
  findOrCreateRegistryPackage,
  InvalidDigestError,
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
  releaseRegistryBlobRef,
  storeRegistryBlobStreamWithRef,
} from "@hootifactory/registry";
import {
  buildNarInfoMeta,
  narFileHashFromUrl,
  narFileHashToDigest,
  type ParsedNarInfo,
  parseNarInfoMeta,
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

  // The NAR's coordinate (`<fileHash>`) is its own sha256 — this is a
  // content-addressed store. Hand CAS the expected digest so a client cannot
  // PUT arbitrary bytes under a valid-looking file hash and poison the cache:
  // a hash mismatch is rejected at the storage boundary (404/400 below). The
  // fileHash arrives as either 64-char hex or 52-char Nix base32; both decode
  // to the same canonical `sha256:<hex>` digest.
  const expectedDigest = narFileHashToDigest(fileHash);
  if (!expectedDigest) {
    return new Response("invalid NAR file hash", { status: 400 });
  }

  // Stream the NAR straight into content-addressable storage rather than
  // buffering the whole archive in memory — NARs can be gigabytes, so
  // `req.arrayBuffer()` would invite OOM and cap throughput. CAS computes the
  // digest and size as it consumes the stream and verifies it against
  // `expectedDigest`.
  let stored: Awaited<ReturnType<typeof storeRegistryBlobStreamWithRef>>;
  try {
    stored = await storeRegistryBlobStreamWithRef(ctx, {
      data: req.body,
      expectedDigest,
      kind: NAR_BLOB_KIND,
      scope,
      mediaType: "application/x-nix-nar",
    });
  } catch (err) {
    if (err instanceof InvalidDigestError) {
      return new Response("NAR contents do not match the file hash", { status: 400 });
    }
    throw err;
  }

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
  // 204 No Content for a body-less successful upload, matching the narinfo PUT
  // so both halves of a single `nix copy --to` push report success alike.
  return new Response(null, { status: 204 });
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

  // Referential integrity: the narinfo must describe a NAR that actually lives
  // in this cache, and its claimed FileHash/FileSize must match the stored
  // blob. Otherwise a substituter would fetch the narinfo, download the NAR,
  // and fail the NarHash check (or be served mismatched bytes). The NAR is
  // uploaded first (PUT /nar/...), so we can reconcile against it here.
  const integrity = await checkReferencedNar(ctx, parsed, narFileHash);
  if (integrity) return integrity;

  // Guarantee the narinfo we accept is one we can actually serve: the read path
  // re-validates stored metadata against the strict schema, so reject anything
  // here that would later parse to null and 404 a published path (a 204 publish
  // must imply a 200-servable narinfo).
  if (!parseNarInfoMeta(buildNarInfoMeta(parsed, { digest: PLACEHOLDER_DIGEST, narFileHash }))) {
    return new Response("invalid narinfo", { status: 400 });
  }

  const scope = narInfoScope(storeHash);
  const bodyBytes = new TextEncoder().encode(body);
  return publishImmutableVersionBlobResponse(ctx, {
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
    // Narinfos are keyed by store hash and re-publishing is last-writer-wins:
    // a second PUT overwrites the stored metadata. This is safe because a store
    // path's identity (NarHash/References) is fixed, while the legitimately
    // variable fields (FileHash/URL/Compression/Sig) are reconciled against the
    // referenced NAR above before either version is accepted.
    versionConflict: () => Promise.resolve(false),
    conflictResponse: () => new Response("conflict", { status: 409 }),
    successResponse: () => new Response(null, { status: 204 }),
  });
}

export const NARINFO_KIND = "nix_narinfo";

/**
 * A syntactically valid `sha256:<hex>` digest used only to exercise the strict
 * read-side schema during the narinfo PUT dry-run. The real narinfo blob digest
 * is substituted by `publishImmutableVersionBlob` when the version is committed.
 */
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

/**
 * Reconcile a narinfo against the NAR it references. The NAR is uploaded before
 * its narinfo, so by the time the narinfo arrives the blob must already exist
 * and its content-addressed digest + stored size must match the narinfo's
 * claimed `FileHash` and `FileSize`. Returns an error Response on a mismatch (or
 * a missing NAR), or null when the narinfo is consistent with the stored blob.
 */
async function checkReferencedNar(
  ctx: RegistryRequestContext,
  parsed: ParsedNarInfo,
  narFileHash: string,
): Promise<Response | null> {
  const expectedDigest = narFileHashToDigest(narFileHash);
  const claimedDigest = narFileHashToDigest(parsed.fileHash.replace(/^sha256:/, ""));
  // The bare URL hash and the FileHash line must name the same NAR.
  if (!expectedDigest || expectedDigest !== claimedDigest) {
    return new Response("narinfo FileHash does not match the referenced NAR", { status: 400 });
  }

  const narScope = narBlobScope(narFileHash);
  const pkg = await ctx.data.packages.findByName(narScope);
  const row = pkg ? await ctx.data.versions.findLive(pkg, NARINFO_VERSION) : null;
  const meta = row?.metadata as { blobDigest?: unknown; sizeBytes?: unknown } | undefined;
  if (!meta || typeof meta.blobDigest !== "string") {
    return new Response("referenced NAR has not been uploaded", { status: 409 });
  }
  if (meta.blobDigest !== expectedDigest) {
    return new Response("stored NAR digest does not match the narinfo FileHash", { status: 409 });
  }
  if (typeof meta.sizeBytes === "number" && meta.sizeBytes !== parsed.fileSize) {
    return new Response("narinfo FileSize does not match the stored NAR", { status: 409 });
  }
  return null;
}

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
