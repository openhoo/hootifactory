import { Sha256DigestSchema, Sha256HexSchema, z } from "@hootifactory/registry";

/**
 * Conda channel subdirs (platforms). `noarch` plus the documented platform
 * triples. Kept permissive enough for any `<os>-<arch>` form while rejecting
 * path-y/traversal input.
 */
export function isValidCondaSubdir(subdir: string): boolean {
  return /^(?:noarch|[a-z0-9]+-[a-z0-9_]+)$/.test(subdir);
}

/** Conda package/channel names: lowercase letters, digits, dot, underscore, dash. */
export function isValidCondaPackageName(name: string): boolean {
  return /^[a-z0-9._-]+$/.test(name);
}

/** Conda versions are permissive: letters, digits, dot, plus, underscore, dash, bang, star. */
export function isValidCondaVersion(version: string): boolean {
  return /^[A-Za-z0-9.+_!*-]+$/.test(version);
}

/** A channel name (proxy upstream segment): same charset as a package name. */
export function isValidCondaChannel(channel: string): boolean {
  return /^[a-z0-9._-]+$/.test(channel);
}

export const CondaSubdirSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidCondaSubdir, "invalid Conda subdir");

export const CondaPackageNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidCondaPackageName, "invalid Conda package name");

export const CondaVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidCondaVersion, "invalid Conda version");

/**
 * A package filename. Conda packages are `<name>-<version>-<build>.conda`
 * (new format) or `<name>-<version>-<build>.tar.bz2` (legacy). The name must
 * not contain path separators.
 */
const PACKAGE_EXT_RE = /\.(?:conda|tar\.bz2)$/;

export const CondaFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename")
  .refine((value) => PACKAGE_EXT_RE.test(value), "unsupported package extension");

/**
 * Cheap archive-format sniff for an uploaded package blob. The `index.json`
 * metadata in a publish is publisher-asserted and never cross-checked against
 * the archive contents, so at minimum the stored blob must be the archive its
 * filename claims: a `.conda` file is a zip (`PK\x03\x04` local-file header) and
 * a legacy `.tar.bz2` is a bzip2 stream (`BZh` magic). This rejects a blob whose
 * bytes are not the declared archive format (e.g. a JSON or text payload smuggled
 * under a package filename) without unpacking the archive.
 */
export function hasCondaArchiveMagic(kind: CondaPackageKind, bytes: Uint8Array): boolean {
  if (kind === "conda") {
    // ZIP local-file header: "PK\x03\x04".
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  // bzip2 stream header: "BZh".
  return bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68;
}

/** `"packages.conda"` holds `.conda` files; `"packages"` holds legacy `.tar.bz2`. */
export type CondaPackageKind = "conda" | "tarbz2";

export function condaPackageKind(filename: string): CondaPackageKind | null {
  if (filename.endsWith(".conda")) return "conda";
  if (filename.endsWith(".tar.bz2")) return "tarbz2";
  return null;
}

/** Strip the package extension to recover `<name>-<version>-<build>`. */
export function condaFilenameStem(filename: string): string {
  if (filename.endsWith(".conda")) return filename.slice(0, -".conda".length);
  if (filename.endsWith(".tar.bz2")) return filename.slice(0, -".tar.bz2".length);
  return filename;
}

export interface CondaPackageCoordinates {
  name: string;
  version: string;
  build: string;
}

/**
 * Parse `<name>-<version>-<build>` from a package filename. Conda splits on the
 * last two dashes: the final field is the build string, the second-to-last is
 * the version, and everything before is the (dash-containing) package name.
 */
export function parseCondaFilename(filename: string): CondaPackageCoordinates | null {
  if (!CondaFilenameSchema.safeParse(filename).success) return null;
  const stem = condaFilenameStem(filename);
  const lastDash = stem.lastIndexOf("-");
  if (lastDash <= 0) return null;
  const build = stem.slice(lastDash + 1);
  const rest = stem.slice(0, lastDash);
  const versionDash = rest.lastIndexOf("-");
  if (versionDash <= 0) return null;
  const version = rest.slice(versionDash + 1);
  const name = rest.slice(0, versionDash);
  if (!build || !version || !name) return null;
  if (!isValidCondaPackageName(name) || !isValidCondaVersion(version)) return null;
  return { name, version, build };
}

/** Constraints (`depends`/`constrains`) are free-form match specs; bound the size only. */
const MatchSpecSchema = z.string().min(1).max(512);

/**
 * The publisher-supplied `index.json` metadata. Conda accepts a rich set of
 * fields; we capture the ones that appear in `repodata.json` entries and pass
 * the rest through loosely. `name`/`version`/`build` are required and must be
 * consistent with the filename.
 */
export const CondaIndexJsonSchema = z.looseObject({
  name: CondaPackageNameSchema,
  version: CondaVersionSchema,
  build: z.string().min(1).max(256),
  build_number: z.number().int().min(0).max(1_000_000).optional(),
  depends: z.array(MatchSpecSchema).max(4096).optional(),
  constrains: z.array(MatchSpecSchema).max(4096).optional(),
  subdir: CondaSubdirSchema.optional(),
  license: z.string().max(512).optional(),
  license_family: z.string().max(256).optional(),
  timestamp: z.number().int().min(0).optional(),
  arch: z.string().max(64).nullable().optional(),
  platform: z.string().max(64).nullable().optional(),
  track_features: z.string().max(2048).optional(),
  features: z.string().max(2048).optional(),
  noarch: z.union([z.string().max(64), z.boolean()]).optional(),
});

export type CondaIndexJson = z.output<typeof CondaIndexJsonSchema>;

const Md5HexSchema = z.string().regex(/^[a-f0-9]{32}$/);

/**
 * What we persist per version. The publisher's `index.json` fields plus the
 * blob coordinates the download route resolves against and the checksums the
 * `repodata.json` index advertises.
 */
export const CondaVersionMetaSchema = z.looseObject({
  index: CondaIndexJsonSchema,
  subdir: CondaSubdirSchema,
  filename: CondaFilenameSchema,
  packageKind: z.enum(["conda", "tarbz2"]),
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  md5: Md5HexSchema,
  size: z.number().int().min(0),
});

export type CondaVersionMeta = z.output<typeof CondaVersionMetaSchema>;

export function parseCondaVersionMeta(value: unknown): CondaVersionMeta | null {
  const parsed = CondaVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A single `repodata.json` package record: the `index.json` fields plus the
 * checksums/size conda clients verify the download against. `subdir` is always
 * present so clients can locate the file.
 */
export interface CondaRepodataRecord {
  name: string;
  version: string;
  build: string;
  build_number: number;
  subdir: string;
  md5: string;
  sha256: string;
  size: number;
  depends: string[];
  constrains?: string[];
  license?: string;
  license_family?: string;
  timestamp?: number;
  track_features?: string;
  features?: string;
  noarch?: string | boolean;
  [key: string]: unknown;
}

/** Build the `repodata.json` record for one stored version. */
export function buildCondaRepodataRecord(meta: CondaVersionMeta): CondaRepodataRecord {
  const idx = meta.index;
  const record: CondaRepodataRecord = {
    name: idx.name,
    version: idx.version,
    build: idx.build,
    build_number: idx.build_number ?? 0,
    subdir: meta.subdir,
    md5: meta.md5,
    sha256: meta.sha256,
    size: meta.size,
    depends: idx.depends ?? [],
  };
  if (idx.constrains !== undefined) record.constrains = idx.constrains;
  if (idx.license !== undefined) record.license = idx.license;
  if (idx.license_family !== undefined) record.license_family = idx.license_family;
  if (idx.timestamp !== undefined) record.timestamp = idx.timestamp;
  if (idx.track_features !== undefined) record.track_features = idx.track_features;
  if (idx.features !== undefined) record.features = idx.features;
  if (idx.noarch !== undefined) record.noarch = idx.noarch;
  return record;
}

/** Persist the publisher index.json + blob coordinates for a version. */
export function buildCondaVersionMeta(
  index: CondaIndexJson,
  blob: {
    subdir: string;
    filename: string;
    packageKind: CondaPackageKind;
    digest: string;
    sha256: string;
    md5: string;
    size: number;
  },
): CondaVersionMeta & Record<string, unknown> {
  return {
    index,
    subdir: blob.subdir,
    filename: blob.filename,
    packageKind: blob.packageKind,
    blobDigest: blob.digest,
    sha256: blob.sha256,
    md5: blob.md5,
    size: blob.size,
  };
}
