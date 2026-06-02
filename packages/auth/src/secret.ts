/**
 * Shared crypto primitives for opaque-secret hashing and generation.
 * Centralizes the SHA-256-hex digest, base64url encoding, and the
 * high-entropy random-secret recipe used by tokens, sessions, and email tokens.
 */

export function sha256hex(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Generate a high-entropy opaque secret string, optionally prefixed. */
export function randomSecret(prefix = ""): string {
  return `${prefix}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
