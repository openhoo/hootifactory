import { z } from "@hootifactory/core";
import { isSafeDistributionFilename, isValidProjectName } from "./simple";

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
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as PypiVersionMetadata;
  return {
    ...metadata,
    files: Array.isArray(metadata.files) ? metadata.files : [],
  };
}

function normalizeFilenameVersionToken(version: string): string {
  return version.toLowerCase().replace(/[-_.]+/g, "_");
}
