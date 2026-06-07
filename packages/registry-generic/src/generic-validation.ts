import { z } from "@hootifactory/registry";

/**
 * Generic/raw paths are arbitrary, repo-relative, slash-separated blob addresses
 * (e.g. `releases/1.0/app.tar.gz`). They are *mutable* addresses, not digests:
 * a `PUT` overwrites whatever lives at the path. We forbid the usual traversal /
 * absolute-path / dot-segment foot-guns so a path always maps to exactly one
 * stable storage scope.
 */
export function isValidGenericPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  // No leading/trailing slash (paths are relative) and no backslashes (a
  // Windows-style separator that would alias the forward-slash form).
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    // Reject ASCII control bytes (NUL..US and DEL) in a stored path.
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const segments = path.split("/");
  for (const segment of segments) {
    // Empty (`//`), `.` and `..` segments would let a path escape its own
    // addressable space or alias another path.
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

export const GenericPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isValidGenericPath, "invalid generic path");

/**
 * A directory prefix used by the index listing. Same rules as a path but it is
 * allowed to be empty (the repository root).
 */
export function isValidGenericPrefix(prefix: string): boolean {
  if (prefix === "") return true;
  return isValidGenericPath(prefix);
}

export const GenericPrefixSchema = z
  .string()
  .max(1024)
  .refine(isValidGenericPrefix, "invalid generic prefix");

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Sha512HexSchema = z.string().regex(/^[a-f0-9]{128}$/);

/**
 * What we persist per stored path. The blob lives in CAS keyed by `blobDigest`;
 * `sha256`/`sha512` are the checksum sidecars served back on reads and exposed by
 * the index listing. `contentType` is the media type the uploader declared.
 */
export const GenericVersionMetaSchema = z.looseObject({
  path: GenericPathSchema,
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  sha512: Sha512HexSchema,
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(256),
});

export type GenericVersionMeta = z.output<typeof GenericVersionMetaSchema>;

export function parseGenericVersionMeta(value: unknown): GenericVersionMeta | null {
  const parsed = GenericVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface GenericStoredBlobInfo {
  path: string;
  blobDigest: string;
  sha256: string;
  sha512: string;
  size: number;
  contentType: string;
}

export function buildGenericVersionMeta(
  info: GenericStoredBlobInfo,
): GenericVersionMeta & Record<string, unknown> {
  return {
    path: info.path,
    blobDigest: info.blobDigest,
    sha256: info.sha256,
    sha512: info.sha512,
    size: info.size,
    contentType: info.contentType,
  };
}

/**
 * A generic path is mapped to a package version: `path` becomes the package name
 * and a single version `"current"` holds the live blob. Re-uploading a path
 * replaces the version (mutable address), so we use a stable version id.
 */
export const GENERIC_VERSION = "current";

/** Stable blob-ref scope for a stored generic path. */
export function genericBlobScope(path: string): string {
  return `generic/${path}`;
}

/** The default media type when an uploader supplies none. */
export const DEFAULT_GENERIC_CONTENT_TYPE = "application/octet-stream";

/** Normalize an uploader-supplied content-type, falling back to the default. */
export function normalizeGenericContentType(raw: string | null): string {
  if (!raw) return DEFAULT_GENERIC_CONTENT_TYPE;
  const trimmed = raw.split(";")[0]?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 256) return DEFAULT_GENERIC_CONTENT_TYPE;
  // A media type is `type/subtype`; reject anything that is not a sane token pair.
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(trimmed)) {
    return DEFAULT_GENERIC_CONTENT_TYPE;
  }
  return trimmed;
}

export interface GenericIndexEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** Build the directory/index listing rows for the given stored metadata. */
export function buildGenericIndexEntries(
  metas: GenericVersionMeta[],
  prefix: string,
): GenericIndexEntry[] {
  const normalizedPrefix = prefix === "" ? "" : `${prefix.replace(/\/$/, "")}/`;
  const entries: GenericIndexEntry[] = [];
  for (const meta of metas) {
    if (normalizedPrefix !== "" && !meta.path.startsWith(normalizedPrefix)) continue;
    entries.push({
      path: meta.path,
      size: meta.size,
      sha256: meta.sha256,
      contentType: meta.contentType,
    });
  }
  // Codepoint ordering (not `localeCompare`, whose result varies by host
  // locale/ICU) so the listing — and its ETag — is byte-stable across runtimes.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}
