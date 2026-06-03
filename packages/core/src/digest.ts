/** sha256 digest helpers. Digests are the canonical "sha256:<64-hex>" form. */

export const SHA256_PREFIX = "sha256:";
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function isValidDigest(digest: string): boolean {
  return DIGEST_RE.test(digest);
}

export function assertDigest(digest: string): void {
  if (!isValidDigest(digest)) {
    throw new InvalidDigestError(digest);
  }
}

export class InvalidDigestError extends Error {
  constructor(public readonly digest: string) {
    super(`invalid digest: ${digest}`);
    this.name = "InvalidDigestError";
  }
}

export function digestHex(digest: string): string {
  return digest.slice(SHA256_PREFIX.length);
}

/** Compute the sha256 digest of in-memory data. */
export function computeDigest(data: Uint8Array | ArrayBuffer | string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data as Uint8Array);
  return SHA256_PREFIX + hasher.digest("hex");
}

/**
 * Content-addressable storage key with two levels of fan-out to avoid hot
 * prefixes: blobs/sha2/<aa>/<bb>/<hex>.
 */
export function blobKey(digest: string, prefix = "blobs/sha2"): string {
  assertDigest(digest);
  const hex = digestHex(digest);
  return `${prefix}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

/** Staging key for in-progress uploads. */
export function stagingKey(uploadId: string, suffix = ""): string {
  return `uploads/${uploadId}${suffix}`;
}
