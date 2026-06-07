import { z } from "@hootifactory/registry";

/**
 * Pacman/Arch package names: lowercase-friendly but Arch permits letters, digits,
 * and `@ . _ + -`. A name may not start with a hyphen, dot, or plus.
 */
const ARCH_PKGNAME_RE = /^[A-Za-z0-9@._][A-Za-z0-9@._+-]*$/;
/** `pkgver` is `[epoch:]version-pkgrel`; allow the chars pacman uses for those. */
const ARCH_PKGVER_RE = /^[A-Za-z0-9][A-Za-z0-9._+:~-]*$/;
/** A pacman architecture token (`x86_64`, `aarch64`, `any`, ...). */
const ARCH_ARCH_RE = /^[A-Za-z0-9_]+$/;
/** Repository (database) name — appears in `<repo>.db` and the mount tree. */
const ARCH_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidArchPkgName(name: string): boolean {
  return ARCH_PKGNAME_RE.test(name);
}
export function isValidArchPkgVer(version: string): boolean {
  return ARCH_PKGVER_RE.test(version);
}
export function isValidArchArch(arch: string): boolean {
  return ARCH_ARCH_RE.test(arch);
}
export function isValidArchRepo(repo: string): boolean {
  return ARCH_REPO_RE.test(repo);
}

export const ArchPkgNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(ARCH_PKGNAME_RE, "invalid pkgname");
export const ArchPkgVerSchema = z.string().min(1).max(255).regex(ARCH_PKGVER_RE, "invalid pkgver");
export const ArchArchSchema = z.string().min(1).max(64).regex(ARCH_ARCH_RE, "invalid arch");
export const ArchRepoSchema = z.string().min(1).max(128).regex(ARCH_REPO_RE, "invalid repository");

/** The package archive extensions pacman understands. */
const PKG_FILE_RE = /^[A-Za-z0-9@._+-]+\.pkg\.tar\.(?:zst|xz)$/;

export const ArchPkgFileSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename")
  .refine((value) => PKG_FILE_RE.test(value), "unsupported package extension");

export function isArchPkgFile(file: string): boolean {
  return PKG_FILE_RE.test(file) && !file.includes("/") && !file.includes("\\");
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * What we persist per published package version. `pkgname`/`pkgver`/`arch` and
 * `depends` are recorded EXPLICITLY (parsed from `.PKGINFO`, with a filename
 * fallback) so the sync DB can be rebuilt deterministically and the `.pkg`
 * blob resolved on download without re-reading the archive.
 */
/** A pacman relation list (`depend`/`provides`/`conflict`/...). */
const ArchRelationList = z.array(z.string().min(1).max(512)).max(4096);

export const ArchVersionMetaSchema = z.strictObject({
  /** CAS blob digest of the package payload (`sha256:<hex>`). */
  blobDigest: Sha256DigestSchema,
  /** sha256 hex of the whole package (matches `digestHex(blobDigest)`). */
  sha256: Sha256HexSchema,
  /** Canonical package filename = blob scope leaf. */
  filename: ArchPkgFileSchema,
  pkgname: ArchPkgNameSchema,
  pkgver: ArchPkgVerSchema,
  arch: ArchArchSchema,
  /** On-disk (compressed) size of the package in bytes. */
  csize: z.number().int().min(0),
  /** Runtime dependencies (`depend = ...` lines from `.PKGINFO`). */
  depends: ArchRelationList,
  /**
   * `pkgbase` — the base name a split package was built from. Differs from
   * `pkgname` for split packages; surfaced as `%BASE%` and the AUR
   * `PackageBase`. Optional (single packages omit it in `.PKGINFO`).
   */
  pkgbase: ArchPkgNameSchema.optional(),
  /** Virtual packages provided (`provides = ...`) → `%PROVIDES%`. */
  provides: ArchRelationList.optional(),
  /** Conflicting packages (`conflict = ...`) → `%CONFLICTS%`. */
  conflicts: ArchRelationList.optional(),
  /** Packages this one replaces (`replaces = ...`) → `%REPLACES%`. */
  replaces: ArchRelationList.optional(),
  /** Optional dependencies (`optdepend = ...`) → `%OPTDEPENDS%`. */
  optdepends: ArchRelationList.optional(),
  /** `pkgdesc` from `.PKGINFO`, when present. */
  pkgdesc: z.string().max(8192).optional(),
});

export type ArchVersionMeta = z.output<typeof ArchVersionMetaSchema>;

export function parseArchVersionMeta(value: unknown): ArchVersionMeta | null {
  const parsed = ArchVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface ArchPkgInfo {
  pkgname?: string;
  pkgbase?: string;
  pkgver?: string;
  arch?: string;
  pkgdesc?: string;
  depends: string[];
  provides: string[];
  conflicts: string[];
  replaces: string[];
  optdepends: string[];
}

/**
 * Parse a `.PKGINFO` text body. The format is one `key = value` per line, with
 * `#`-prefixed comment lines; the relation keys (`depend`/`provides`/
 * `conflict`/`replaces`/`optdepend`) may appear repeatedly. Unknown keys are
 * ignored. Returns the recognized fields plus the accumulated relation lists.
 */
export function parsePkgInfo(text: string): ArchPkgInfo {
  const info: ArchPkgInfo = {
    depends: [],
    provides: [],
    conflicts: [],
    replaces: [],
    optdepends: [],
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value === "") continue;
    switch (key) {
      case "pkgname":
        info.pkgname = value;
        break;
      case "pkgbase":
        info.pkgbase = value;
        break;
      case "pkgver":
        info.pkgver = value;
        break;
      case "arch":
        info.arch = value;
        break;
      case "pkgdesc":
        info.pkgdesc = value;
        break;
      case "depend":
        info.depends.push(value);
        break;
      case "provides":
        info.provides.push(value);
        break;
      case "conflict":
        info.conflicts.push(value);
        break;
      case "replaces":
        info.replaces.push(value);
        break;
      case "optdepend":
        info.optdepends.push(value);
        break;
      default:
        break;
    }
  }
  return info;
}

/**
 * Derive `{ pkgname, pkgver, arch }` from a canonical pacman filename
 * `<pkgname>-<pkgver>-<arch>.pkg.tar.<ext>`. `pkgver` is itself
 * `<version>-<pkgrel>` (two trailing dash-separated fields after the name), so we
 * split from the right: arch is the segment before `.pkg`, pkgrel and version are
 * the two segments before that, and everything else is the name. Returns null
 * when the shape doesn't match.
 */
export function parseArchPkgFileName(
  file: string,
): { pkgname: string; pkgver: string; arch: string } | null {
  const ext = file.endsWith(".pkg.tar.zst")
    ? ".pkg.tar.zst"
    : file.endsWith(".pkg.tar.xz")
      ? ".pkg.tar.xz"
      : null;
  if (!ext) return null;
  const base = file.slice(0, -ext.length);
  const archDash = base.lastIndexOf("-");
  if (archDash <= 0) return null;
  const arch = base.slice(archDash + 1);
  const namePkgrel = base.slice(0, archDash);
  const pkgrelDash = namePkgrel.lastIndexOf("-");
  if (pkgrelDash <= 0) return null;
  const pkgrel = namePkgrel.slice(pkgrelDash + 1);
  const nameVer = namePkgrel.slice(0, pkgrelDash);
  const verDash = nameVer.lastIndexOf("-");
  if (verDash <= 0) return null;
  const version = nameVer.slice(verDash + 1);
  const pkgname = nameVer.slice(0, verDash);
  const pkgver = `${version}-${pkgrel}`;
  if (!isValidArchPkgName(pkgname) || !isValidArchPkgVer(pkgver) || !isValidArchArch(arch)) {
    return null;
  }
  return { pkgname, pkgver, arch };
}

/** The canonical pacman package filename for a stored version. */
export function archPkgFileName(
  meta: { pkgname: string; pkgver: string; arch: string },
  ext: "zst" | "xz" = "zst",
): string {
  return `${meta.pkgname}-${meta.pkgver}-${meta.arch}.pkg.tar.${ext}`;
}
