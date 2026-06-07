import { z } from "@hootifactory/registry";

/**
 * Alpine package names: lowercase/uppercase letters, digits, and `+-._` (e.g.
 * `musl`, `py3-foo`, `gcc-libs`). Kept permissive but bounded to avoid path or
 * index injection.
 */
export function isValidAlpineName(name: string): boolean {
  return name.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(name);
}

/**
 * Alpine versions are `pkgver-r<pkgrel>` (e.g. `1.2.3-r0`, `2.0_alpha1-r4`). We
 * accept the broad character set apk uses (digits, dots, `+_~`, letters, and the
 * `-r` release suffix) without trying to fully model apkv ordering.
 */
export function isValidAlpineVersion(version: string): boolean {
  return version.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9+._~-]*$/.test(version);
}

/**
 * Alpine architectures: `x86_64`, `aarch64`, `armv7`, `x86`, `armhf`, `ppc64le`,
 * `s390x`, `riscv64`, plus the meta-arch `noarch`.
 */
export function isValidAlpineArch(arch: string): boolean {
  return arch.length <= 32 && /^[a-z0-9_]+$/.test(arch);
}

export const AlpineNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidAlpineName, "invalid Alpine package name");

export const AlpineVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidAlpineVersion, "invalid Alpine version");

export const AlpineArchSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(isValidAlpineArch, "invalid Alpine architecture");

/** A published artifact filename: `<name>-<version>.apk`, no path separators. */
export const AlpineApkFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename")
  .refine((value) => value.endsWith(".apk"), "expected a .apk filename");

/**
 * The canonical apk filename for a package version. apk clients fetch
 * `<name>-<version>.apk` (the `V:` field is included verbatim, release suffix and
 * all), so the index's implied download path must use exactly this shape.
 */
export function apkFilename(name: string, version: string): string {
  return `${name}-${version}.apk`;
}
