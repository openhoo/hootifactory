import { z } from "@hootifactory/registry";

/**
 * Hex package names: lowercase letters, digits and underscore. Hex.pm enforces a
 * leading letter and `[a-z0-9_]` body; we mirror that (and reject any path-y or
 * uppercase input so a name can never escape its mount segment).
 */
const PACKAGE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * SemVer 2.0.0. Hex uses Elixir's `Version`, which is SemVer with the usual
 * numeric core + optional dash prerelease + optional plus build metadata.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidHexPackageName(name: string): boolean {
  return PACKAGE_NAME_RE.test(name);
}

export function isValidHexVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

export const HexPackageNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidHexPackageName, "invalid Hex package name");

export const HexVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidHexVersion, "invalid SemVer version");

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * The release metadata we extract from a tarball's `metadata.config`. `name`,
 * `version` and `app` are required (Mix needs `app` to compile a dep); the rest
 * are descriptive and optional. `requirements` is the dependency map keyed by the
 * required package name; we keep the requirement string so the scanner can build
 * a dependency graph.
 */
export const HexReleaseMetadataSchema = z.object({
  name: HexPackageNameSchema,
  version: HexVersionSchema,
  app: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*$/, "invalid OTP application name"),
  description: z.string().max(8192).optional(),
  licenses: z.array(z.string().max(256)).max(64).optional(),
  build_tools: z.array(z.string().max(128)).max(64).optional(),
  requirements: z.record(z.string(), z.string()).optional(),
});

export type HexReleaseMetadata = z.output<typeof HexReleaseMetadataSchema>;

/**
 * What we persist per release: the parsed release metadata plus the blob
 * coordinates the tarball route resolves against. `innerChecksum`/`outerChecksum`
 * are the bare hex Hex clients verify the download against; `outerChecksum` is the
 * sha256 of the whole tarball (= the stored blob), `innerChecksum` is the sha256
 * over the inner contents recorded in the tarball's `CHECKSUM` member.
 */
export const HexVersionMetaSchema = z.object({
  metadata: HexReleaseMetadataSchema,
  blobDigest: Sha256DigestSchema,
  outerChecksum: Sha256HexSchema,
  innerChecksum: Sha256HexSchema,
  published: z.string().min(1).max(64),
});

export type HexVersionMeta = z.output<typeof HexVersionMetaSchema>;

export function parseHexVersionMeta(value: unknown): HexVersionMeta | null {
  const parsed = HexVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The tarball filename `<name>-<version>.tar` served by the download route. */
export const HexTarballFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z][a-z0-9_]*-[0-9][A-Za-z0-9._+-]*\.tar$/, "invalid tarball filename");

/** Split `<name>-<version>.tar` into a valid package name + version, or null. */
export function splitTarballFile(file: string): { name: string; version: string } | null {
  if (!file.endsWith(".tar")) return null;
  const stem = file.slice(0, -".tar".length);
  const dash = stem.indexOf("-");
  if (dash <= 0) return null;
  const name = stem.slice(0, dash);
  const version = stem.slice(dash + 1);
  if (!HexPackageNameSchema.safeParse(name).success) return null;
  if (!HexVersionSchema.safeParse(version).success) return null;
  return { name, version };
}

/** The canonical `<name>-<version>.tar` download filename for a release. */
export function hexTarballFile(name: string, version: string): string {
  return `${name}-${version}.tar`;
}

/** Build the per-release metadata we persist from the parsed tarball + blob coords. */
export function buildHexVersionMeta(
  metadata: HexReleaseMetadata,
  blob: { digest: string; outerChecksum: string; innerChecksum: string },
): HexVersionMeta {
  return {
    metadata,
    blobDigest: blob.digest,
    outerChecksum: blob.outerChecksum,
    innerChecksum: blob.innerChecksum,
    published: new Date().toISOString(),
  };
}
