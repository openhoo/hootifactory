import { z } from "@hootifactory/registry";

/**
 * CRAN package names: start with a letter, then letters/digits/dots, at least
 * two characters, and must not end with a dot (per `Writing R Extensions`).
 */
export function isValidCranPackageName(name: string): boolean {
  return name.length <= 128 && /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/.test(name);
}

/**
 * CRAN package versions: one or more digit groups separated by `.` or `-`
 * (e.g. `1.0`, `1.2.3`, `0.9-7`). Must begin and end with a digit.
 */
export function isValidCranVersion(version: string): boolean {
  return version.length <= 64 && /^[0-9]+([.-][0-9]+)*$/.test(version);
}

export const CranPackageNameSchema = z
  .string()
  .min(2)
  .max(128)
  .refine(isValidCranPackageName, "invalid CRAN package name");

export const CranVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidCranVersion, "invalid CRAN version");

/** A source-tarball filename `<pkg>_<version>.tar.gz` split into its parts. */
export interface CranFilenameParts {
  name: string;
  version: string;
}

/**
 * Parse a `<pkg>_<version>.tar.gz` filename into `{ name, version }`. The package
 * name and version are validated against their schemas; the split uses the FIRST
 * underscore before the suffix because CRAN versions never contain `_` while
 * package names never do either, so any `_` separates the two unambiguously.
 */
export function parseCranTarballFilename(filename: string): CranFilenameParts | null {
  if (filename.includes("/") || filename.includes("\\")) return null;
  const suffix = ".tar.gz";
  if (!filename.endsWith(suffix)) return null;
  const stem = filename.slice(0, -suffix.length);
  const underscore = stem.indexOf("_");
  if (underscore <= 0) return null;
  const name = stem.slice(0, underscore);
  const version = stem.slice(underscore + 1);
  if (!isValidCranPackageName(name) || !isValidCranVersion(version)) return null;
  return { name, version };
}

/** The canonical `src/contrib/<pkg>_<version>.tar.gz` filename for a version. */
export function cranTarballFilename(name: string, version: string): string {
  return `${name}_${version}.tar.gz`;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Md5HexSchema = z.string().regex(/^[a-f0-9]{32}$/);

/**
 * Per-version metadata persisted on publish. `controlFields` holds the DESCRIPTION
 * fields the index serializer re-emits (so PACKAGES stanzas reproduce the source
 * package's own metadata), and the blob coordinates resolve the download route.
 * `md5` is over the tarball bytes — CRAN's PACKAGES carries it and clients verify
 * the file they fetch against it.
 */
export const CranVersionMetaSchema = z.looseObject({
  name: CranPackageNameSchema,
  version: CranVersionSchema,
  /** Ordered DESCRIPTION field pairs carried into the PACKAGES index. */
  controlFields: z.array(z.tuple([z.string().max(256), z.string().max(65536)])).max(256),
  /** Bare dependency names (Depends + Imports + LinkingTo), for scan graphing. */
  deps: z.array(z.string().max(256)).max(2048),
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  md5: Md5HexSchema,
  sizeBytes: z.number().int().nonnegative(),
});

export type CranVersionMeta = z.output<typeof CranVersionMetaSchema>;

export function parseCranVersionMeta(value: unknown): CranVersionMeta | null {
  const parsed = CranVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
