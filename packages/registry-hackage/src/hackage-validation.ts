import { z } from "@hootifactory/registry";

/**
 * Hackage package names are dash-separated alphanumeric components, where every
 * component must contain at least one letter (so a name component is never a bare
 * number — that disambiguates `<name>-<version>` ids, since the trailing
 * numeric-only components are the version). Cabal enforces the same rule.
 */
export function isValidHackageName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  const components = name.split("-");
  return components.every(
    (component) => /^[A-Za-z0-9]+$/.test(component) && /[A-Za-z]/.test(component),
  );
}

/** Cabal/PVP versions are dot-separated non-negative integers (e.g. `1.2.3.0`). */
export function isValidHackageVersion(version: string): boolean {
  if (version.length === 0 || version.length > 128) return false;
  return /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/.test(version);
}

export const HackageNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidHackageName, "invalid Hackage package name");

export const HackageVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidHackageVersion, "invalid Hackage version");

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * What we persist per published version: the raw `.cabal` text (the source of
 * truth re-served verbatim in the `01-index.tar.gz`), the descriptive fields we
 * parsed out of it, and the blob coordinates the sdist download route resolves.
 */
export const HackageVersionMetaSchema = z.looseObject({
  name: HackageNameSchema,
  version: HackageVersionSchema,
  synopsis: z.string().max(2048).optional(),
  license: z.string().max(512).optional(),
  author: z.string().max(2048).optional(),
  homepage: z.string().max(2048).optional(),
  buildDepends: z.array(z.string().min(1).max(256)).max(2048).optional(),
  cabal: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
});

export type HackageVersionMeta = z.output<typeof HackageVersionMetaSchema>;

export function parseHackageVersionMeta(value: unknown): HackageVersionMeta | null {
  const parsed = HackageVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The accepted fields parsed from an uploaded `.cabal` file. */
export interface CabalFields {
  name: string;
  version: string;
  synopsis?: string;
  license?: string;
  author?: string;
  homepage?: string;
  buildDepends: string[];
}

/**
 * Parse the top-level fields of a `.cabal` file we care about. Cabal is a
 * line-oriented `field: value` format with case-insensitive field names and
 * indentation-based continuation lines; we read the package stanza's simple
 * scalar fields plus every `build-depends` (which may appear in multiple
 * `library`/`executable` stanzas, possibly spanning continuation lines).
 *
 * Returns null when the mandatory `name`/`version` fields are absent or invalid.
 */
export function parseCabal(text: string): CabalFields | null {
  const lines = text.split(/\r?\n/);
  const scalars: Record<string, string> = {};
  const dependencyTokens: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripCabalComment(lines[i] ?? "");
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.trimStart().length;

    const colon = stripped.indexOf(":");
    // A `field: value` line (at any indentation — package fields sit at indent 0,
    // stanza fields like `build-depends` are nested). Lines without a colon are
    // stanza headers (`library`, `executable demo`) and are skipped.
    if (colon < 0) continue;
    const field = stripped.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(field)) continue;
    let value = stripped.slice(colon + 1).trim();

    // Fold continuation lines (indented deeper than this field) into the value.
    while (i + 1 < lines.length) {
      const nextRaw = stripCabalComment(lines[i + 1] ?? "");
      if (!nextRaw.trim()) break;
      const nextIndent = nextRaw.length - nextRaw.trimStart().length;
      if (nextIndent <= indent) break;
      value = `${value} ${nextRaw.trim()}`;
      i++;
    }

    if (field === "build-depends") {
      for (const token of value.split(",")) {
        const dep = extractDependencyName(token);
        if (dep) dependencyTokens.push(dep);
      }
      continue;
    }
    // First occurrence of a scalar field wins (the package stanza is first).
    if (!(field in scalars)) scalars[field] = value;
  }

  const name = scalars.name;
  const version = scalars.version;
  if (!name || !version) return null;
  if (!isValidHackageName(name) || !isValidHackageVersion(version)) return null;

  const fields: CabalFields = {
    name,
    version,
    buildDepends: [...new Set(dependencyTokens)].sort(),
  };
  if (scalars.synopsis) fields.synopsis = scalars.synopsis.slice(0, 2048);
  if (scalars.license) fields.license = scalars.license.slice(0, 512);
  if (scalars.author) fields.author = scalars.author.slice(0, 2048);
  if (scalars.homepage) fields.homepage = scalars.homepage.slice(0, 2048);
  return fields;
}

/** Strip a `--` line comment that begins at whitespace or line start. */
function stripCabalComment(line: string): string {
  const idx = line.search(/(^|\s)--/);
  return idx >= 0 ? line.slice(0, idx) : line;
}

/** Pull the bare package name out of a single `build-depends` entry. */
function extractDependencyName(token: string): string | null {
  const name = token
    .trim()
    .split(/[\s>=<^]/)[0]
    ?.trim();
  if (!name) return null;
  return isValidHackageName(name) ? name : null;
}

/**
 * Split a Hackage package id `<name>-<version>` into its parts. The version is
 * the trailing run of dot-separated numeric components; everything before it is
 * the name. Returns null when the id is not a valid name+version pair.
 */
export function splitPackageId(id: string): { name: string; version: string } | null {
  const lastDash = lastVersionDash(id);
  if (lastDash < 0) return null;
  const name = id.slice(0, lastDash);
  const version = id.slice(lastDash + 1);
  if (!isValidHackageName(name) || !isValidHackageVersion(version)) return null;
  return { name, version };
}

/**
 * Find the dash that separates the name from the version: the last dash whose
 * suffix is a valid version. Scanning from the left lets `foo-bar-1.0` split at
 * `foo-bar` / `1.0` even though `bar-1.0` also parses as a (different) id.
 */
function lastVersionDash(id: string): number {
  for (let i = 0; i < id.length; i++) {
    if (id[i] !== "-") continue;
    if (isValidHackageVersion(id.slice(i + 1))) return i;
  }
  return -1;
}

/** The canonical sdist tarball filename for a package id. */
export function sdistFilename(name: string, version: string): string {
  return `${name}-${version}.tar.gz`;
}
