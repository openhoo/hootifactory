import { asJsonRecord, Sha256DigestSchema, Sha256HexSchema, z } from "@hootifactory/registry";
import { MAX_MANIFEST_BYTES } from "./swift-manifest";

/**
 * SwiftPM package scopes are 1-39 char alphanumeric runs separated by single
 * hyphens (no leading/trailing/consecutive hyphens) per SE-0292.
 */
export function isValidSwiftScope(scope: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(scope);
}

/**
 * SwiftPM package names are 1-100 char alphanumeric tokens that may contain
 * single internal hyphens/underscores per SE-0292: a `[-_]` may not be leading,
 * trailing, or consecutive (must be followed by an alphanumeric).
 */
export function isValidSwiftName(name: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9])){0,99}$/.test(name);
}

/** Releases are identified by SemVer 2.0.0 version strings. */
export function isValidSwiftVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  );
}

/**
 * The canonical package identifier SwiftPM and our storage/RBAC layers key on:
 * `scope.name`, normalized to lowercase. SE-0292 mandates that scope and name
 * are case-insensitive (mona ≍ MONA, LinkedList ≍ LINKEDLIST resolve to the
 * SAME package), so normalizing here makes lookups, conflict checks, and the
 * stored package name agree regardless of the casing a client requests.
 */
export function swiftPackageId(scope: string, name: string): string {
  return `${scope}.${name}`.toLowerCase();
}

/** The RBAC package name — the canonical (already-lowercased) package id. */
export function swiftPermissionName(scope: string, name: string): string {
  return swiftPackageId(scope, name);
}

/** The blob-ref scope for a release's source archive (case-normalized). */
export function swiftArchiveScope(scope: string, name: string, version: string): string {
  return `${swiftPackageId(scope, name)}@${version}.zip`;
}

export const SwiftScopeSchema = z
  .string()
  .min(1)
  .max(39)
  .refine(isValidSwiftScope, "invalid package scope");

export const SwiftNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidSwiftName, "invalid package name");

export const SwiftVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidSwiftVersion, "invalid SemVer version");

/**
 * Per-version metadata stored at publish time. `archiveDigest` is the CAS
 * blob digest (`sha256:<hex>`); `checksum` is the bare hex SwiftPM advertises.
 */
export const SwiftVersionMetaSchema = z.strictObject({
  archiveDigest: Sha256DigestSchema,
  checksum: Sha256HexSchema,
  metadata: z.record(z.string(), z.unknown()),
  manifest: z.string().max(MAX_MANIFEST_BYTES).optional(),
});

export type SwiftVersionMeta = z.output<typeof SwiftVersionMetaSchema>;

export function parseSwiftVersionMeta(value: unknown): SwiftVersionMeta | null {
  const parsed = SwiftVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Best-effort read of the stored client metadata object. */
export function readSwiftClientMetadata(value: unknown): Record<string, unknown> {
  const meta = parseSwiftVersionMeta(value);
  if (meta) return meta.metadata;
  const record = asJsonRecord(value);
  const nested = record ? asJsonRecord(record.metadata) : null;
  return nested ?? {};
}
