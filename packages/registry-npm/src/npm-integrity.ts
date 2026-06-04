export interface NpmDist {
  filename: string;
  blobDigest: string;
  shasum: string;
  integrity: string;
  size: number;
}

export interface PublishVersion {
  version: string;
  manifest: Record<string, unknown>;
  tarball: Buffer;
}

export function sha1hex(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(data);
  return h.digest("hex");
}

export function sha512b64(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha512");
  h.update(data);
  return h.digest("base64");
}

function digestB64(algorithm: "sha1" | "sha256" | "sha384" | "sha512", data: Uint8Array): string {
  const h = new Bun.CryptoHasher(algorithm);
  h.update(data);
  return h.digest("base64");
}

const INTEGRITY_ALGORITHMS = new Set(["sha1", "sha256", "sha384", "sha512"]);

function integrityTokenMatches(token: string, data: Uint8Array): boolean {
  const value = token.split("?")[0] ?? "";
  const separator = value.indexOf("-");
  if (separator <= 0) return false;
  const algorithm = value.slice(0, separator) as "sha1" | "sha256" | "sha384" | "sha512";
  const expected = value.slice(separator + 1);
  if (!INTEGRITY_ALGORITHMS.has(algorithm) || !expected) return false;
  return digestB64(algorithm, data) === expected;
}

export function upstreamDistMatchesBytes(
  dist: { integrity?: string; shasum?: string },
  data: Uint8Array,
): boolean {
  if (
    (typeof dist.integrity !== "string" || !dist.integrity.trim()) &&
    (typeof dist.shasum !== "string" || !dist.shasum.trim())
  ) {
    return false;
  }
  if (typeof dist.integrity === "string" && dist.integrity.trim()) {
    const tokens = dist.integrity.trim().split(/\s+/);
    if (!tokens.some((token) => integrityTokenMatches(token, data))) return false;
  }
  if (typeof dist.shasum === "string" && dist.shasum.trim()) {
    if (sha1hex(data) !== dist.shasum.trim().toLowerCase()) return false;
  }
  return true;
}

export function upstreamDistMatchesStored(
  dist: { integrity?: string; shasum?: string },
  stored: NpmDist,
): boolean {
  let checked = false;
  if (typeof dist.integrity === "string" && dist.integrity.trim()) {
    checked = true;
    const tokens = dist.integrity
      .trim()
      .split(/\s+/)
      .map((token) => token.split("?")[0] ?? "");
    if (!tokens.includes(stored.integrity)) return false;
  }
  if (typeof dist.shasum === "string" && dist.shasum.trim()) {
    checked = true;
    if (dist.shasum.trim().toLowerCase() !== stored.shasum) return false;
  }
  return checked;
}
