import { z } from "@hootifactory/registry";

export function basename(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}

export function packagePath(name: string): string {
  return encodeURIComponent(name);
}

/** npm new-package rules: optional scope, URL-safe, lowercase-only, <=214 chars. */
export function isValidNpmName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

/** npm legacy read/proxy rules: old public packages may contain uppercase letters. */
export function isValidLegacyNpmName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return /^(@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/.test(name);
}

export function isValidNpmVersion(version: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return false;
  for (const id of (match[4] ?? "").split(".").filter(Boolean)) {
    if (/^\d+$/.test(id) && !/^(0|[1-9]\d*)$/.test(id)) return false;
  }
  return true;
}

export function isValidDistTag(tag: string): boolean {
  if (!tag || tag.length > 214) return false;
  if (!/^[A-Za-z][A-Za-z0-9._~-]*$/.test(tag)) return false;
  if (/^v\d/i.test(tag)) return false;
  return !isValidNpmVersion(tag);
}

export const NpmPackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .refine(isValidNpmName, "invalid npm package name");
export const NpmLegacyPackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .refine(isValidLegacyNpmName, "invalid npm package name");
export const NpmVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidNpmVersion, "invalid npm version");
export const NpmDistTagSchema = z
  .string()
  .min(1)
  .max(214)
  .refine(isValidDistTag, "invalid npm dist-tag");
export const NpmTarballFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^/\\]+\.tgz$/, "invalid tarball filename");
export const NpmSearchQuerySchema = z.strictObject({
  text: z.string().max(256).default(""),
  from: z.coerce.number().int().min(0).max(10_000).default(0),
  size: z.coerce.number().int().min(0).max(10_000).default(20),
});
export const NpmPublishManifestSchema = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  dist: z.record(z.string(), z.unknown()).optional(),
});
export const NpmPublishBodySchema = z.looseObject({
  name: z.string().optional(),
  versions: z.record(z.string(), NpmPublishManifestSchema).default({}),
  _attachments: z.record(z.string(), z.looseObject({ data: z.string() })).default({}),
  "dist-tags": z.record(z.string(), z.string()).optional(),
});
