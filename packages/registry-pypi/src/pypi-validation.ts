import { asJsonRecord, Sha256DigestSchema, z } from "@hootifactory/registry";

export interface PypiFileMeta {
  filename: string;
  blobDigest: string;
  sha256: string;
  requiresPython?: string;
  size: number;
  filetype?: string;
}

export type PypiVersionMetadata = {
  name?: string;
  requiresPython?: string;
  files?: PypiFileMeta[];
};

export type AddPypiFileResult =
  | { ok: true; versionId: string }
  | { ok: false; reason: "file_exists" | "version_exists" };

/** Core Metadata project names: ASCII alnum with internal dot/underscore/hyphen separators. */
export function isValidProjectName(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name);
}

export function isSafeDistributionFilename(filename: string): boolean {
  return (
    Boolean(filename) &&
    /^[A-Za-z0-9][A-Za-z0-9._+!-]*$/.test(filename) &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}

export const PypiProjectParamSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => isValidProjectName(value), "invalid project name");

export const PypiFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => isSafeDistributionFilename(value), "invalid distribution filename");

export const PypiUploadFieldsSchema = z.strictObject({
  name: PypiProjectParamSchema,
  version: z.string().min(1).max(256),
  sha256_digest: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  requires_python: z.string().min(1).max(256).optional(),
  filetype: z.string().min(1).max(64).optional(),
});

export const PypiFileMetaSchema = z.strictObject({
  filename: PypiFilenameSchema,
  blobDigest: Sha256DigestSchema,
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  requiresPython: z.string().min(1).max(256).optional(),
  size: z.number().int().safe().min(0),
  filetype: z.string().min(1).max(64).optional(),
});

export function filenameVersionMatches(declared: string, fromFilename: string): boolean {
  return (
    declared.toLowerCase() === fromFilename.toLowerCase() ||
    normalizeFilenameVersionToken(declared) === normalizeFilenameVersionToken(fromFilename)
  );
}

export function parsePypiFilename(filename: string): { name: string; version: string } | null {
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -".whl".length).split("-");
    if (parts.length < 5 || !parts[0] || !parts[1]) return null;
    return { name: parts[0], version: parts[1] };
  }

  const sourceBase = filename.endsWith(".tar.gz")
    ? filename.slice(0, -".tar.gz".length)
    : filename.endsWith(".zip")
      ? filename.slice(0, -".zip".length)
      : null;
  if (!sourceBase) return null;
  const sep = sourceBase.lastIndexOf("-");
  if (sep <= 0 || sep === sourceBase.length - 1) return null;
  return { name: sourceBase.slice(0, sep), version: sourceBase.slice(sep + 1) };
}

export function normalizePypiVersionMetadata(value: unknown): PypiVersionMetadata {
  const metadata = asJsonRecord(value);
  if (!metadata) return {};

  const out: PypiVersionMetadata = {};
  if (typeof metadata.name === "string") out.name = metadata.name;
  if (typeof metadata.requiresPython === "string") out.requiresPython = metadata.requiresPython;
  if (Object.hasOwn(metadata, "files")) out.files = readPypiFileMetadataList(metadata.files);
  return out;
}

export function readPypiVersionFileMetadata(value: unknown): PypiFileMeta[] {
  const metadata = asJsonRecord(value);
  return metadata ? readPypiFileMetadataList(metadata.files) : [];
}

export function readPypiFileMetadataList(value: unknown): PypiFileMeta[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    const metadata = pypiFileMetaFromStoredRecord(file);
    return metadata ? [metadata] : [];
  });
}

function pypiFileMetaFromStoredRecord(value: unknown): PypiFileMeta | null {
  const file = asJsonRecord(value);
  if (!file) return null;
  const { blobDigest, filename, filetype, requiresPython, sha256, size } = file;
  if (
    typeof filename !== "string" ||
    !isSafeDistributionFilename(filename) ||
    typeof blobDigest !== "string" ||
    typeof sha256 !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    return null;
  }
  if (requiresPython !== undefined && typeof requiresPython !== "string") return null;
  if (filetype !== undefined && typeof filetype !== "string") return null;
  return {
    filename,
    blobDigest,
    sha256,
    ...(requiresPython === undefined ? {} : { requiresPython }),
    size,
    ...(filetype === undefined ? {} : { filetype }),
  };
}

function normalizeFilenameVersionToken(version: string): string {
  return version.toLowerCase().replace(/[-_.]+/g, "_");
}
