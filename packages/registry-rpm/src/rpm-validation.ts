import { z } from "@hootifactory/registry";

/**
 * Per-version metadata stored for an RPM package. The epoch/ver/rel/arch are
 * recorded EXPLICITLY (never re-parsed from the version string) so repodata can
 * be rebuilt deterministically and the `.rpm` blob resolved on download.
 */
export interface RpmVersionMeta {
  /** Stored package version string: `<epoch>:<ver>-<rel>.<arch>`. */
  rpmDigest: string;
  file: string;
  name: string;
  ver: string;
  rel: string;
  arch: string;
  epoch: number;
  /** sha256 hex of the whole `.rpm` (matches `digestHex(rpmDigest)`). */
  sha256: string;
  size: number;
  summary?: string;
}

// RPM package names are conservative: letters, digits, and `+ - . _ ~`.
const RPM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+~-]*$/;
// ver/rel disallow `-` (the field separator) and `/`.
const RPM_VER_REL_RE = /^[A-Za-z0-9_.+~^]+$/;
const RPM_ARCH_RE = /^[A-Za-z0-9_]+$/;
const RPM_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.+~^-]*\.rpm$/;

export function isValidRpmName(name: string): boolean {
  return RPM_NAME_RE.test(name);
}

export const RpmNameSchema = z.string().min(1).max(256).regex(RPM_NAME_RE, "invalid RPM name");

export const RpmFileSchema = z.string().min(5).max(512).regex(RPM_FILE_RE, "invalid RPM filename");

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const RpmVersionMetaSchema = z.strictObject({
  rpmDigest: Sha256DigestSchema,
  file: RpmFileSchema,
  name: RpmNameSchema,
  ver: z.string().min(1).max(256).regex(RPM_VER_REL_RE, "invalid version"),
  rel: z.string().min(1).max(256).regex(RPM_VER_REL_RE, "invalid release"),
  arch: z.string().min(1).max(64).regex(RPM_ARCH_RE, "invalid arch"),
  epoch: z.number().int().min(0),
  sha256: Sha256HexSchema,
  size: z.number().int().min(0),
  summary: z.string().max(8192).optional(),
});

export function parseRpmVersionMeta(value: unknown): RpmVersionMeta | null {
  const parsed = RpmVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The stored package-version key: `<epoch>:<ver>-<rel>.<arch>`. */
export function rpmVersionKey(input: {
  epoch: number;
  ver: string;
  rel: string;
  arch: string;
}): string {
  return `${input.epoch}:${input.ver}-${input.rel}.${input.arch}`;
}

/** The canonical `.rpm` filename: `<name>-<ver>-<rel>.<arch>.rpm`. */
export function rpmFileName(input: {
  name: string;
  ver: string;
  rel: string;
  arch: string;
}): string {
  return `${input.name}-${input.ver}-${input.rel}.${input.arch}.rpm`;
}

export interface RpmNevra {
  name: string;
  ver: string;
  rel: string;
  arch: string;
}

/**
 * Parse `<name>-<ver>-<rel>.<arch>.rpm` into its components. Used as a fallback
 * when an `.rpm` header tag is absent. Returns null if the shape doesn't match.
 */
export function parseRpmFileName(file: string): RpmNevra | null {
  if (!RPM_FILE_RE.test(file)) return null;
  const base = file.slice(0, -".rpm".length);
  // arch is the segment after the final dot.
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const arch = base.slice(lastDot + 1);
  const nameVerRel = base.slice(0, lastDot);
  // rel is the segment after the final `-`; ver the one before it; name the rest.
  const relDash = nameVerRel.lastIndexOf("-");
  if (relDash <= 0) return null;
  const rel = nameVerRel.slice(relDash + 1);
  const nameVer = nameVerRel.slice(0, relDash);
  const verDash = nameVer.lastIndexOf("-");
  if (verDash <= 0) return null;
  const ver = nameVer.slice(verDash + 1);
  const name = nameVer.slice(0, verDash);
  if (!name || !ver || !rel || !arch) return null;
  if (!RPM_NAME_RE.test(name)) return null;
  if (!RPM_VER_REL_RE.test(ver) || !RPM_VER_REL_RE.test(rel)) return null;
  if (!RPM_ARCH_RE.test(arch)) return null;
  return { name, ver, rel, arch };
}
