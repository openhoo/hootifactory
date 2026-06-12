import { Sha256DigestSchema, z } from "@hootifactory/registry";

/**
 * Nix store-path hashes are 32-character base32 (Nix's own base32 alphabet:
 * `0123456789abcdfghijklmnpqrsvwxyz`, i.e. no `e o u t`). They key both the
 * `<storehash>.narinfo` lookup and the `StorePath` line.
 */
const NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz";
const STORE_HASH_RE = new RegExp(`^[${NIX_BASE32}]{32}$`);

/** Reverse lookup for the Nix base32 alphabet. */
const NIX_BASE32_REV: Record<string, number> = {};
for (let i = 0; i < NIX_BASE32.length; i++) NIX_BASE32_REV[NIX_BASE32.charAt(i)] = i;

/** Validate a 32-char Nix base32 store-path hash. */
export function isValidStoreHash(hash: string): boolean {
  return STORE_HASH_RE.test(hash);
}

export const StoreHashSchema = z
  .string()
  .length(32)
  .refine(isValidStoreHash, "invalid Nix store-path hash");

/**
 * NAR file hashes (the `FileHash`/`URL` key) are content-addressed. Nix writes
 * them as `sha256:<base32>` (52 base32 chars) or `sha256:<hex>` (64 hex chars);
 * the URL component reuses the bare hash. We accept either encoding so the cache
 * round-trips whatever the client produced.
 */
const FILE_HASH_BASE32_RE = new RegExp(`^[${NIX_BASE32}]{52}$`);
const FILE_HASH_HEX_RE = /^[0-9a-f]{64}$/;

export function isValidNarFileHash(hash: string): boolean {
  return FILE_HASH_BASE32_RE.test(hash) || FILE_HASH_HEX_RE.test(hash);
}

export const NarFileHashSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidNarFileHash, "invalid NAR file hash");

/** Byte length of a sha256 digest (the only hash Nix file hashes encode here). */
const SHA256_BYTES = 32;

/**
 * Decode a 52-char Nix base32 string into the underlying 32-byte sha256.
 * Nix base32 packs bits little-endian and the encoded characters run in reverse
 * byte order, so we read the string from its end. Returns null on a wrong
 * length, a character outside the alphabet, or nonzero overflow bits past the
 * 32nd byte (an invalid encoding).
 */
function decodeNixBase32Sha256(s: string): Uint8Array | null {
  if (s.length !== 52) return null;
  const bytes = new Uint8Array(SHA256_BYTES);
  for (let n = 0; n < s.length; n++) {
    const digit = NIX_BASE32_REV[s.charAt(s.length - n - 1)];
    if (digit === undefined) return null;
    const bit = n * 5;
    const i = bit >> 3;
    const j = bit & 7;
    bytes[i] = ((bytes[i] ?? 0) | ((digit << j) & 0xff)) & 0xff;
    const carry = digit >> (8 - j);
    if (i + 1 < SHA256_BYTES) {
      bytes[i + 1] = ((bytes[i + 1] ?? 0) | carry) & 0xff;
    } else if (carry !== 0) {
      return null;
    }
  }
  return bytes;
}

/**
 * Convert a bare NAR file hash (the `URL`/`FileHash` value, either 64-char hex
 * or 52-char Nix base32) into the canonical `sha256:<64-hex>` CAS digest so the
 * upload can be verified against the content-addressed store. Returns null for
 * any value that is not a recognised sha256 encoding.
 */
export function narFileHashToDigest(fileHash: string): string | null {
  if (FILE_HASH_HEX_RE.test(fileHash)) return `sha256:${fileHash}`;
  if (!FILE_HASH_BASE32_RE.test(fileHash)) return null;
  const bytes = decodeNixBase32Sha256(fileHash);
  if (!bytes) return null;
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** `sha256:<base32|hex>` hash refs as they appear in `FileHash`/`NarHash` lines. */
const HASH_REF_RE = new RegExp(`^sha256:(?:[${NIX_BASE32}]{52}|[0-9a-f]{64})$`);
const HashRefSchema = z.string().regex(HASH_REF_RE, "invalid sha256 hash reference");

/** A full store path: `/nix/store/<hash>-<name>`. */
const STORE_PATH_RE = new RegExp(`^/nix/store/[${NIX_BASE32}]{32}-[A-Za-z0-9?=+_.:-]+$`);
const StorePathSchema = z.string().min(1).max(512).regex(STORE_PATH_RE, "invalid store path");

/** A signature line `<key-name>:<base64>`. */
const SIG_RE = /^[A-Za-z0-9._-]+:[A-Za-z0-9+/=]+$/;
const SigSchema = z.string().min(1).max(1024).regex(SIG_RE, "invalid signature");

/** Recognised NAR compression algorithms and their file extensions. */
export const NAR_COMPRESSIONS = {
  none: "",
  xz: ".xz",
  bzip2: ".bz2",
  zstd: ".zst",
  lzip: ".lzip",
  br: ".br",
} as const;

export type NarCompression = keyof typeof NAR_COMPRESSIONS;

const CompressionSchema = z.enum(["none", "xz", "bzip2", "zstd", "lzip", "br"] as [
  NarCompression,
  ...NarCompression[],
]);

/**
 * The narinfo, as persisted per store hash. This is the publisher-supplied
 * manifest minus nothing — Nix narinfos are already content-addressed by the
 * uploader, so we store every field verbatim and re-serialise on read. The
 * `URL` points at our own `nar/<filehash>.nar[.ext]` route, and `narFileHash`
 * is the bare hash the NAR blob is stored under.
 */
export const NarInfoMetaSchema = z.looseObject({
  storePath: StorePathSchema,
  url: z.string().min(1).max(512),
  compression: CompressionSchema,
  fileHash: HashRefSchema,
  fileSize: z.number().int().nonnegative(),
  narHash: HashRefSchema,
  narSize: z.number().int().nonnegative(),
  references: z.array(z.string().min(1).max(256)).max(4096),
  deriver: z.string().min(1).max(512).optional(),
  system: z.string().min(1).max(128).optional(),
  ca: z.string().min(1).max(512).optional(),
  sig: z.array(SigSchema).max(64),
  /** The bare NAR file hash (no `sha256:` prefix) the blob is stored under. */
  narFileHash: NarFileHashSchema,
  /** sha256:<hex> digest of the stored NAR blob, for scanning + download. */
  blobDigest: Sha256DigestSchema,
});

export type NarInfoMeta = z.output<typeof NarInfoMetaSchema>;

export function parseNarInfoMeta(value: unknown): NarInfoMeta | null {
  const parsed = NarInfoMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Cache info served at `GET /nix-cache-info`. */
export const NIX_CACHE_INFO = "StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n";

/** A parsed narinfo body (what a `PUT /<storehash>.narinfo` carries). */
export interface ParsedNarInfo {
  storePath: string;
  url: string;
  compression: NarCompression;
  fileHash: string;
  fileSize: number;
  narHash: string;
  narSize: number;
  references: string[];
  deriver?: string;
  system?: string;
  ca?: string;
  sig: string[];
}

/**
 * Parse a strictly-decimal, non-negative size field. Nix writes `FileSize`/
 * `NarSize` as plain decimal byte counts, so anything with a sign, trailing
 * garbage (`12abc`), or beyond the safe-integer range is rejected rather than
 * silently coerced — a malformed size would otherwise persist into the stored
 * manifest and the re-served narinfo.
 */
function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse a narinfo text body into its fields. The narinfo grammar is one
 * `Key: value` per line; `References` is space-separated; `Sig` may repeat.
 * Returns `null` when a required field is missing or malformed.
 */
export function parseNarInfoText(body: string): ParsedNarInfo | null {
  const fields = new Map<string, string[]>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const idx = line.indexOf(":");
    if (idx < 0) return null;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const existing = fields.get(key);
    if (existing) existing.push(value);
    else fields.set(key, [value]);
  }

  const single = (key: string): string | undefined => fields.get(key)?.[0];
  const storePath = single("StorePath");
  const url = single("URL");
  const compressionRaw = single("Compression") ?? "none";
  const fileHash = single("FileHash");
  const fileSizeRaw = single("FileSize");
  const narHash = single("NarHash");
  const narSizeRaw = single("NarSize");
  if (!storePath || !url || !fileHash || !narHash || !fileSizeRaw || !narSizeRaw) return null;

  const fileSize = parseNonNegativeInt(fileSizeRaw);
  const narSize = parseNonNegativeInt(narSizeRaw);
  if (fileSize === null || narSize === null) return null;

  const compression =
    (NAR_COMPRESSIONS as Record<string, string>)[compressionRaw] !== undefined
      ? (compressionRaw as NarCompression)
      : null;
  if (!compression) return null;

  const references = (single("References") ?? "").split(/\s+/).filter((ref) => ref.length > 0);

  const parsed: ParsedNarInfo = {
    storePath,
    url,
    compression,
    fileHash,
    fileSize,
    narHash,
    narSize,
    references,
    sig: fields.get("Sig") ?? [],
  };
  const deriver = single("Deriver");
  if (deriver && deriver !== "unknown-deriver") parsed.deriver = deriver;
  const system = single("System");
  if (system) parsed.system = system;
  const ca = single("CA");
  if (ca) parsed.ca = ca;
  return parsed;
}

/**
 * Extract the bare NAR file hash (no `sha256:` prefix, no extension) from a
 * narinfo `URL` line. The `URL` must be a relative `nar/<filehash>.nar[.ext]`
 * reference into this registry's own `/nar/...` route — absolute URLs or any
 * other path shape are rejected so a publisher can't persist a narinfo that
 * redirects clients to an arbitrary location. The extracted hash must itself be
 * a valid NAR file hash.
 */
export function narFileHashFromUrl(url: string): string | null {
  const match = url.match(/^nar\/([^/.]+)\.nar(?:\.[A-Za-z0-9]+)?$/);
  const hash = match?.[1];
  return hash && isValidNarFileHash(hash) ? hash : null;
}

/** Serialise stored narinfo metadata back into the canonical narinfo text body. */
export function buildNarInfoText(meta: NarInfoMeta): string {
  const lines = [
    `StorePath: ${meta.storePath}`,
    `URL: ${meta.url}`,
    `Compression: ${meta.compression}`,
    `FileHash: ${meta.fileHash}`,
    `FileSize: ${meta.fileSize}`,
    `NarHash: ${meta.narHash}`,
    `NarSize: ${meta.narSize}`,
    `References: ${meta.references.join(" ")}`,
  ];
  if (meta.deriver) lines.push(`Deriver: ${meta.deriver}`);
  if (meta.system) lines.push(`System: ${meta.system}`);
  if (meta.ca) lines.push(`CA: ${meta.ca}`);
  for (const sig of meta.sig) lines.push(`Sig: ${sig}`);
  return `${lines.join("\n")}\n`;
}

/** Build the persisted narinfo metadata from a parsed body + stored-blob coordinates. */
export function buildNarInfoMeta(
  parsed: ParsedNarInfo,
  blob: { digest: string; narFileHash: string },
): NarInfoMeta & Record<string, unknown> {
  const meta: NarInfoMeta = {
    storePath: parsed.storePath,
    url: parsed.url,
    compression: parsed.compression,
    fileHash: parsed.fileHash,
    fileSize: parsed.fileSize,
    narHash: parsed.narHash,
    narSize: parsed.narSize,
    references: parsed.references,
    sig: parsed.sig,
    narFileHash: blob.narFileHash,
    blobDigest: blob.digest,
  };
  if (parsed.deriver !== undefined) meta.deriver = parsed.deriver;
  if (parsed.system !== undefined) meta.system = parsed.system;
  if (parsed.ca !== undefined) meta.ca = parsed.ca;
  return meta;
}
