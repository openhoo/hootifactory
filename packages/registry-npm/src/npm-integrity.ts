import { computeDigest } from "@hootifactory/registry";

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

export interface NpmTarballDigests {
  blobDigest: string;
  shasum: string;
  integrity: string;
}

export function computeNpmTarballDigests(data: Uint8Array): NpmTarballDigests {
  return {
    blobDigest: computeDigest(data),
    shasum: sha1hex(data),
    integrity: `sha512-${sha512b64(data)}`,
  };
}

function integrityTokenParts(token: string): {
  algorithm: "sha1" | "sha256" | "sha384" | "sha512";
  expected: string;
} | null {
  const value = token.split("?")[0] ?? "";
  const separator = value.indexOf("-");
  if (separator <= 0) return null;
  const algorithm = value.slice(0, separator) as "sha1" | "sha256" | "sha384" | "sha512";
  const expected = value.slice(separator + 1);
  if (!INTEGRITY_ALGORITHMS.has(algorithm) || !expected) return null;
  return { algorithm, expected };
}

function hexDigestB64(digest: string): string | null {
  const hex = digest.split(":")[1];
  return hex ? Buffer.from(hex, "hex").toString("base64") : null;
}

function sha1HexB64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function integrityTokenMatchesDigests(
  token: string,
  digests: NpmTarballDigests,
  data: Uint8Array,
): boolean {
  const parts = integrityTokenParts(token);
  if (!parts) return false;
  if (parts.algorithm === "sha512") return digests.integrity === `sha512-${parts.expected}`;
  if (parts.algorithm === "sha1") return sha1HexB64(digests.shasum) === parts.expected;
  if (parts.algorithm === "sha256") return hexDigestB64(digests.blobDigest) === parts.expected;
  return digestB64(parts.algorithm, data) === parts.expected;
}

export function upstreamDistMatchesDigests(
  dist: { integrity?: string; shasum?: string },
  digests: NpmTarballDigests,
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
    if (!tokens.some((token) => integrityTokenMatchesDigests(token, digests, data))) return false;
  }
  if (typeof dist.shasum === "string" && dist.shasum.trim()) {
    if (digests.shasum !== dist.shasum.trim().toLowerCase()) return false;
  }
  return true;
}

export function upstreamDistMatchesBytes(
  dist: { integrity?: string; shasum?: string },
  data: Uint8Array,
): boolean {
  const digests = computeNpmTarballDigests(data);
  return upstreamDistMatchesDigests(dist, digests, data);
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
