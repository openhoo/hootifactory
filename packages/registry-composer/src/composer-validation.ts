import { z } from "@hootifactory/registry";

/** Composer vendor segment (lowercase; dot/underscore/hyphen separators). */
export function isValidComposerVendor(vendor: string): boolean {
  return vendor.length <= 100 && /^[a-z0-9]([_.-]?[a-z0-9]+)*$/.test(vendor);
}

/** Composer package segment (lowercase; allows up to double hyphens between tokens). */
export function isValidComposerPackage(pkg: string): boolean {
  return pkg.length <= 100 && /^[a-z0-9](([_.]?|-{1,2})[a-z0-9]+)*$/.test(pkg);
}

/** Composer version: semver-ish tags (optionally `v`-prefixed) or `dev-<branch>`. */
export function isValidComposerVersion(version: string): boolean {
  return (
    version.length <= 128 &&
    /^(dev-[A-Za-z0-9._/-]+|v?\d+(\.\d+){0,3}([-+][A-Za-z0-9._-]+)?)$/.test(version)
  );
}

/** Dist path `<vendor>/<package>/<version>.zip` with no traversal. */
export function isValidComposerDistPath(path: string): boolean {
  if (path.length > 320 || path.includes("\\") || path.includes("..") || path.startsWith("/")) {
    return false;
  }
  const segments = path.split("/");
  return segments.length === 3 && segments.every(Boolean) && path.endsWith(".zip");
}

export const ComposerVendorSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidComposerVendor, "invalid composer vendor");

export const ComposerPackageSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidComposerPackage, "invalid composer package");

export const ComposerVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidComposerVersion, "invalid composer version");

export const ComposerDistPathSchema = z
  .string()
  .min(1)
  .max(320)
  .refine(isValidComposerDistPath, "invalid composer dist path");

/** Strip a `.json` and optional `~dev` suffix from a `/p2/<vendor>/<package>` segment. */
export function stripMetadataSuffix(packageParam: string): { pkg: string; dev: boolean } {
  let value = packageParam;
  if (value.endsWith(".json")) value = value.slice(0, -".json".length);
  const dev = value.endsWith("~dev");
  if (dev) value = value.slice(0, -"~dev".length);
  return { pkg: value, dev };
}
