import { z } from "@hootifactory/registry";

export function isValidSuite(suite: string): boolean {
  return suite.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suite);
}

export function isValidComponent(component: string): boolean {
  return component.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(component);
}

export function isValidArch(arch: string): boolean {
  return arch.length <= 32 && /^[a-z0-9][a-z0-9]*$/.test(arch);
}

/** Pool path under `pool/`, ending in `.deb`, with no traversal. */
export function isSafePoolPath(path: string): boolean {
  return (
    path.length <= 1024 &&
    /^pool\/[A-Za-z0-9][A-Za-z0-9._~:+/-]*\.deb$/.test(path) &&
    !path.includes("..") &&
    !path.includes("//")
  );
}

/** Extract the architecture from a `binary-<arch>` directory segment. */
export function archFromDir(dir: string): string | null {
  if (!dir.startsWith("binary-")) return null;
  const arch = dir.slice("binary-".length);
  return isValidArch(arch) ? arch : null;
}

export const SuiteSchema = z.string().min(1).max(128).refine(isValidSuite, "invalid suite");
export const ComponentSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidComponent, "invalid component");
export const PoolPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafePoolPath, "invalid pool path");
