import { Sha256DigestSchema, z } from "@hootifactory/registry";

/**
 * Rock/module names: LuaRocks normalizes names to lowercase, allowing letters,
 * digits, dot, underscore and dash. We keep the same permissive set used to
 * resolve `<rock>-<version>` filenames.
 */
export function isValidRockName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Rock versions are `<version>-<revision>` where the version part is dotted
 * (e.g. `1.0.0-1`, `2.1-3`, `scm-1`). We accept letters/digits/dots in the
 * version and a numeric revision, joined by a single dash.
 */
export function isValidRockVersion(version: string): boolean {
  return /^[A-Za-z0-9.]+(?:-[0-9]+)?$/.test(version);
}

/** Upper bound on an arch tag, mirrored by `RockArchSchema.max(64)`. */
const MAX_ROCK_ARCH_LENGTH = 64;

/**
 * A rock architecture tag: `src` and `all` plus platform tags such as
 * `linux-x86_64` or `macosx-arm64`. Lowercase letters, digits and underscore,
 * with `-` separating platform from machine. Length is capped so the
 * filename-parse path enforces the same bound as `RockArchSchema`.
 */
export function isValidRockArch(arch: string): boolean {
  if (arch.length > MAX_ROCK_ARCH_LENGTH) return false;
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(arch);
}

export const RockNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidRockName, "invalid LuaRocks module name");

export const RockVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidRockVersion, "invalid LuaRocks version");

export const RockArchSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidRockArch, "invalid LuaRocks architecture");

/** A single parsed dependency constraint string, e.g. `lua >= 5.1`. */
const DependencySchema = z.string().min(1).max(512);

/**
 * What we persist per published version. Both the `.rockspec` and any `.rock`
 * archives for a version share the same package-version row; their blob
 * coordinates are keyed by arch (`rockspec` for the rockspec itself, otherwise
 * the rock's arch tag such as `src`/`all`/`linux-x86_64`).
 */
export const LuarocksVersionMetaSchema = z.looseObject({
  rock: RockNameSchema,
  version: RockVersionSchema,
  summary: z.string().max(2048).optional(),
  homepage: z.string().max(2048).optional(),
  license: z.string().max(512).optional(),
  dependencies: z.array(DependencySchema).max(512).optional(),
  /** arch tag -> stored blob coordinates for the matching `.rock`/`.rockspec`. */
  blobs: z
    .record(
      z.string(),
      z.object({
        digest: Sha256DigestSchema,
        filename: z.string().min(1).max(512),
        sizeBytes: z.number().int().nonnegative(),
      }),
    )
    .default({}),
});

export type LuarocksVersionMeta = z.output<typeof LuarocksVersionMetaSchema>;

/** Total bytes accounted to a version = sum of its stored blob sizes. */
export function versionSizeBytes(meta: LuarocksVersionMeta): number {
  return Object.values(meta.blobs).reduce((sum, blob) => sum + blob.sizeBytes, 0);
}

export function parseLuarocksVersionMeta(value: unknown): LuarocksVersionMeta | null {
  const parsed = LuarocksVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The artifact filename forms LuaRocks understands. */
export interface ParsedRockspecFilename {
  kind: "rockspec";
  rock: string;
  version: string;
}
export interface ParsedRockFilename {
  kind: "rock";
  rock: string;
  version: string;
  arch: string;
}
export type ParsedArtifactFilename = ParsedRockspecFilename | ParsedRockFilename;

/**
 * Parse a LuaRocks artifact filename into its `<rock>-<version>` plus suffix.
 * `<rock>-<version>.rockspec` or `<rock>-<version>.<arch>.rock`. The version is
 * the last `<dotted>-<revision>` group before the suffix, so the rock name may
 * itself contain dashes.
 */
export function parseArtifactFilename(filename: string): ParsedArtifactFilename | null {
  if (filename.includes("/") || filename.includes("\\")) return null;

  if (filename.endsWith(".rockspec")) {
    const stem = filename.slice(0, -".rockspec".length);
    const split = splitNameVersion(stem);
    if (!split) return null;
    return { kind: "rockspec", rock: split.rock, version: split.version };
  }

  if (filename.endsWith(".rock")) {
    const stem = filename.slice(0, -".rock".length);
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) return null;
    const arch = stem.slice(dot + 1);
    const split = splitNameVersion(stem.slice(0, dot));
    if (!split || !isValidRockArch(arch)) return null;
    return { kind: "rock", rock: split.rock, version: split.version, arch };
  }

  return null;
}

/**
 * Split `<rock>-<version>` where version is `<dotted>` optionally followed by
 * `-<revision>`. We scan dashes left-to-right and take the first split whose
 * suffix is a complete valid version — rock names containing dashes (e.g.
 * `lua-cjson`) therefore parse correctly because their leading dashes leave an
 * invalid version suffix. The suffix need not begin with a digit, so versions
 * like `scm-1` (e.g. `lpeg-scm-1.rockspec`) split correctly too.
 */
function splitNameVersion(stem: string): { rock: string; version: string } | null {
  for (let i = 1; i < stem.length; i++) {
    if (stem[i] !== "-") continue;
    const rock = stem.slice(0, i);
    const version = stem.slice(i + 1);
    if (isValidRockName(rock) && isValidRockVersion(version)) {
      return { rock, version };
    }
  }
  return null;
}

/** The arch a `.rockspec` occupies in the manifest's per-version arch list. */
export const ROCKSPEC_ARCH = "rockspec";

/**
 * Render the artifact filename for a stored arch. `rockspec` maps to
 * `<rock>-<version>.rockspec`; any other arch maps to
 * `<rock>-<version>.<arch>.rock`.
 */
export function artifactFilename(rock: string, version: string, arch: string): string {
  return arch === ROCKSPEC_ARCH ? `${rock}-${version}.rockspec` : `${rock}-${version}.${arch}.rock`;
}

/**
 * Parse the accepted rockspec fields. A rockspec is a Lua chunk assigning the
 * globals `package`, `version`, `dependencies`, `description`, `source`,
 * `build`. We extract the fields we serve in the manifest/metadata without
 * executing Lua: `package`, `version`, `dependencies`, plus a few descriptive
 * fields from the `description` table.
 */
export interface ParsedRockspec {
  package: string;
  version: string;
  dependencies: string[];
  summary?: string;
  homepage?: string;
  license?: string;
}

export function parseRockspec(text: string): ParsedRockspec | null {
  const pkg = matchString(text, "package");
  const version = matchString(text, "version");
  if (!pkg || !version) return null;
  if (!isValidRockName(pkg) || !isValidRockVersion(version)) return null;

  const rockspec: ParsedRockspec = {
    package: pkg,
    version,
    dependencies: matchDependencies(text),
  };
  const summary = matchString(text, "summary");
  const homepage = matchString(text, "homepage");
  const license = matchString(text, "license");
  if (summary) rockspec.summary = summary;
  if (homepage) rockspec.homepage = homepage;
  if (license) rockspec.license = license;
  return rockspec;
}

/** Match `<key> = "value"` or `<key> = 'value'` (first occurrence). */
function matchString(text: string, key: string): string | null {
  const re = new RegExp(`(?:^|[\\s{,])${key}\\s*=\\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')`, "m");
  const m = text.match(re);
  return m?.[1] ?? m?.[2] ?? null;
}

/** Extract the string entries of the `dependencies = { ... }` table. */
function matchDependencies(text: string): string[] {
  const block = text.match(/(?:^|[\s{,])dependencies\s*=\s*\{([\s\S]{0,8192}?)\}/m);
  if (!block?.[1]) return [];
  const deps: string[] = [];
  const re = /(?:"([^"]{1,512})"|'([^']{1,512})')/g;
  let m: RegExpExecArray | null = re.exec(block[1]);
  while (m !== null) {
    const value = m[1] ?? m[2];
    if (value) deps.push(value);
    m = re.exec(block[1]);
  }
  return deps;
}
