import { z } from "@hootifactory/registry";

/** Gem names: ASCII alnum with internal dot/underscore/hyphen separators. */
export function isValidGemName(name: string): boolean {
  return name.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** RubyGems versions: numeric segments with optional alphanumeric pre-release tokens. */
export function isValidGemVersion(version: string): boolean {
  return version.length <= 256 && /^[0-9]+(\.[0-9A-Za-z]+)*$/.test(version);
}

/** Distribution filename: safe `.gem` basename with no path separators. */
export function isValidGemFilename(filename: string): boolean {
  return (
    filename.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.gem$/.test(filename) &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}

/** Native gem platform identifier such as `x86_64-linux`; `ruby` is omitted. */
export function isValidGemPlatform(platform: string): boolean {
  return platform.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(platform);
}

export const GemNameSchema = z.string().min(1).max(100).refine(isValidGemName, "invalid gem name");

export const GemVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidGemVersion, "invalid gem version");

export const GemFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isValidGemFilename, "invalid gem filename");
