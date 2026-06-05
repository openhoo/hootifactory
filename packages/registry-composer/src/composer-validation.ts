import { z } from "@hootifactory/registry";

function isAsciiLowerAlnum(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
}

function hasOnlySafeComposerVersionChars(value: string): boolean {
  for (const char of value) {
    if (
      !(
        (char >= "A" && char <= "Z") ||
        (char >= "a" && char <= "z") ||
        (char >= "0" && char <= "9") ||
        char === "." ||
        char === "_" ||
        char === "-" ||
        char === "/" ||
        char === "+"
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Composer vendor segment (lowercase; dot/underscore/hyphen separators). */
export function isValidComposerVendor(vendor: string): boolean {
  if (vendor.length === 0 || vendor.length > 100) return false;
  let previousSeparator = false;
  for (let i = 0; i < vendor.length; i += 1) {
    const char = vendor[i] ?? "";
    if (isAsciiLowerAlnum(char)) {
      previousSeparator = false;
      continue;
    }
    if (char !== "." && char !== "_" && char !== "-") return false;
    if (i === 0 || previousSeparator) return false;
    previousSeparator = true;
  }
  return !previousSeparator;
}

/** Composer package segment (lowercase; allows up to double hyphens between tokens). */
export function isValidComposerPackage(pkg: string): boolean {
  if (pkg.length === 0 || pkg.length > 100) return false;
  let hyphenRun = 0;
  let previousSeparator = false;
  for (let i = 0; i < pkg.length; i += 1) {
    const char = pkg[i] ?? "";
    if (isAsciiLowerAlnum(char)) {
      hyphenRun = 0;
      previousSeparator = false;
      continue;
    }
    if (char === "-") {
      hyphenRun += 1;
      if (i === 0 || hyphenRun > 2) return false;
      previousSeparator = true;
      continue;
    }
    if (char !== "." && char !== "_") return false;
    if (i === 0 || previousSeparator) return false;
    hyphenRun = 0;
    previousSeparator = true;
  }
  return !previousSeparator;
}

/** Composer version: semver-ish tags (optionally `v`-prefixed) or `dev-<branch>`. */
export function isValidComposerVersion(version: string): boolean {
  if (version.length === 0 || version.length > 128 || !hasOnlySafeComposerVersionChars(version)) {
    return false;
  }
  if (version.startsWith("dev-")) {
    const branch = version.slice("dev-".length);
    return (
      branch.length > 0 &&
      !branch.startsWith("/") &&
      !branch.endsWith("/") &&
      branch.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
  }
  const value = version.startsWith("v") ? version.slice(1) : version;
  const plus = value.indexOf("+");
  const hyphen = value.indexOf("-");
  const suffixIndex = plus === -1 ? hyphen : hyphen === -1 ? plus : Math.min(plus, hyphen);
  const numeric = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : value.slice(suffixIndex + 1);
  const parts = numeric.split(".");
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every(
      (part) => part.length > 0 && [...part].every((char) => char >= "0" && char <= "9"),
    ) &&
    (suffixIndex === -1 || (suffix.length > 0 && !suffix.includes("/")))
  );
}

/** Dist path `<vendor>/<package>/<version>.zip`; dev branch versions may contain slashes. */
export function isValidComposerDistPath(path: string): boolean {
  if (path.length > 320 || path.includes("\\") || path.startsWith("/") || !path.endsWith(".zip")) {
    return false;
  }
  const segments = path.split("/");
  if (
    segments.length < 3 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false;
  }
  const vendor = segments[0] ?? "";
  const pkg = segments[1] ?? "";
  const version = segments.slice(2).join("/").slice(0, -".zip".length);
  return (
    isValidComposerVendor(vendor) && isValidComposerPackage(pkg) && isValidComposerVersion(version)
  );
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
