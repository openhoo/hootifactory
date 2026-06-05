import { z } from "@hootifactory/registry";

/** A pub package name: lowercase identifier characters only. */
const PACKAGE_NAME_RE = /^[a-z0-9_]+$/;

/**
 * SemVer 2.0.0 (pub uses pub_semver, which is SemVer with the usual numeric
 * core + optional dash prerelease + optional plus build metadata).
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidDartPackageName(name: string): boolean {
  return PACKAGE_NAME_RE.test(name);
}

export function isValidDartVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

export const DartPackageNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidDartPackageName, "invalid Dart package name");

export const DartVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidDartVersion, "invalid SemVer version");

/** The archive filename `<package>-<version>.tar.gz` served by the download route. */
export const DartArchiveFileSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._+-]*\.tar\.gz$/, "invalid archive filename");

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * The pubspec we keep is the parsed YAML object. We require name+version and
 * keep a handful of well-known optional keys; everything else a publisher put in
 * pubspec.yaml is preserved verbatim under `looseObject`.
 */
export const DartPubspecSchema = z.looseObject({
  name: DartPackageNameSchema,
  version: DartVersionSchema,
  description: z.string().max(8192).optional(),
  homepage: z.string().max(2048).optional(),
  repository: z.string().max(2048).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  dev_dependencies: z.record(z.string(), z.string()).optional(),
});

export type DartPubspec = z.output<typeof DartPubspecSchema>;

export const DartVersionMetaSchema = z.strictObject({
  archiveDigest: Sha256DigestSchema,
  archiveSha256: Sha256HexSchema,
  pubspec: DartPubspecSchema,
  published: z.string().min(1).max(64),
});

export type DartVersionMeta = z.output<typeof DartVersionMetaSchema>;

export function parseDartVersionMeta(value: unknown): DartVersionMeta | null {
  const parsed = DartVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse the top-level scalar/map keys of a pubspec.yaml. This is a deliberately
 * small line parser: pub package metadata we need (name, version, description,
 * environment, dependencies) lives at the document's top level. We read top-level
 * `key: value` scalars and one level of nested `key:`/`  sub: value` maps, which
 * is enough to surface name+version and the dependency graph. Anything we cannot
 * model is dropped (the raw archive remains the source of truth).
 */
export function parsePubspecYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentMapKey: string | null = null;
  let currentMap: Record<string, string> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      currentMapKey = null;
      currentMap = null;
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();

    if (indent === 0) {
      if (value === "") {
        // A top-level mapping key whose entries follow on indented lines.
        currentMapKey = key;
        currentMap = {};
        result[key] = currentMap;
      } else {
        result[key] = unquote(value);
        currentMapKey = null;
        currentMap = null;
      }
    } else if (currentMap && currentMapKey && value !== "") {
      // One level of nesting: `  dep: ^1.0.0`. Skip block scalars (value === "").
      currentMap[key] = unquote(value);
    }
  }

  // Drop empty nested maps so the pubspec stays tidy when, e.g., `dependencies:`
  // is present but only contains complex (non-scalar) entries we don't model.
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === "object" && Object.keys(value).length === 0) {
      delete result[key];
    }
  }
  return result;
}

function stripComment(line: string): string {
  // Only strip an unquoted `#`. Quoted values rarely contain `#` in a pubspec;
  // we keep this simple and only honor a `#` preceded by whitespace or at start.
  const hash = line.search(/(^|\s)#/);
  return hash >= 0 ? line.slice(0, hash) : line;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}
