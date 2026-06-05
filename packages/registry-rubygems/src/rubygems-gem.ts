import { gunzipSync } from "node:zlib";

/**
 * Dependency-free reader for the gemspec inside a `.gem`. A `.gem` is an
 * uncompressed POSIX tar whose `metadata.gz` member is a gzip-compressed,
 * Psych-serialized `Gem::Specification`. The client transmits no metadata
 * alongside the upload, so name/version must come from here.
 */

const MAX_GEM_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TAR_ENTRIES = 64;

export interface GemDependency {
  name: string;
  /** Version constraints joined with `&` (compact-index syntax), e.g. `>= 1.0&< 2.0`. */
  requirements: string;
}

export interface GemMetadata {
  name: string;
  version: string;
  platform?: string;
  dependencies: GemDependency[];
}

function decodeTarName(header: Uint8Array): string {
  let end = 0;
  while (end < 100 && header[end] !== 0) end += 1;
  return new TextDecoder().decode(header.subarray(0, end));
}

function parseOctal(header: Uint8Array, offset: number, length: number): number {
  let str = "";
  for (let i = offset; i < offset + length; i += 1) {
    const code = header[i];
    if (code === undefined || code === 0 || code === 0x20) continue;
    str += String.fromCharCode(code);
  }
  if (!str) return 0;
  const value = Number.parseInt(str, 8);
  return Number.isFinite(value) ? value : -1;
}

/** Return the bytes of the first tar entry named `wanted` (or `./wanted`), or null. */
export function readTarEntry(tar: Uint8Array, wanted: string): Uint8Array | null {
  let offset = 0;
  let scanned = 0;
  while (offset + 512 <= tar.length && scanned < MAX_TAR_ENTRIES) {
    const header = tar.subarray(offset, offset + 512);
    const name = decodeTarName(header);
    if (name === "") break; // zero block: end of archive
    const size = parseOctal(header, 124, 12);
    const dataStart = offset + 512;
    if (size < 0 || dataStart + size > tar.length) break;
    if (name === wanted || name === `./${wanted}`) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
    scanned += 1;
  }
  return null;
}

export function readGemMetadata(gem: Uint8Array): GemMetadata | null {
  const metaGz = readTarEntry(gem, "metadata.gz");
  if (!metaGz) return null;
  let yaml: string;
  try {
    const inflated = gunzipSync(metaGz);
    if (inflated.byteLength > MAX_GEM_METADATA_BYTES) return null;
    yaml = new TextDecoder().decode(inflated);
  } catch {
    return null;
  }
  return parseGemspecYaml(yaml);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Lines belonging to a top-level `key:` block (everything until the next top-level key). */
function topLevelSection(yaml: string, key: string): string | null {
  const header = new RegExp(`^${key}:[^\\n]*\\n`, "m").exec(yaml);
  if (!header) return null;
  const rest = yaml.slice(header.index + header[0].length);
  // Block-sequence items sit at column 0 (`- ...`); stop at the next non-list top-level key.
  const stop = rest.search(/\n(?=[^ \t\n-])/);
  return stop < 0 ? rest : rest.slice(0, stop);
}

function parseConstraints(section: string): string {
  const operators = [...section.matchAll(/^\s*- - ["']?([><=~!]+)["']?\s*$/gm)].map((m) => m[1]);
  const versions = [...section.matchAll(/^\s*version:\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((m) =>
    (m[1] ?? "").trim(),
  );
  const parts = operators.map((op, i) => `${op} ${versions[i] ?? "0"}`);
  return parts.length > 0 ? parts.join("&") : ">= 0";
}

function parseDependencies(yaml: string): GemDependency[] {
  const body = topLevelSection(yaml, "dependencies");
  if (!body) return [];
  const deps: GemDependency[] = [];
  for (const chunk of body.split(/\n(?=- )/)) {
    if (!/Gem::Dependency/.test(chunk)) continue;
    const name = chunk.match(/^\s*name:\s*(.+)$/m)?.[1];
    if (!name) continue;
    const type = chunk.match(/type:\s*:(\w+)/)?.[1] ?? "runtime";
    if (type !== "runtime") continue;
    // The `requirement:` block precedes `type:`; `version_requirements:` follows it.
    const typeIdx = chunk.search(/^\s*type:/m);
    const reqSection = typeIdx >= 0 ? chunk.slice(0, typeIdx) : chunk;
    deps.push({ name: unquote(name), requirements: parseConstraints(reqSection) });
  }
  return deps;
}

export function parseGemspecYaml(yaml: string): GemMetadata | null {
  const nameMatch = yaml.match(/^name:[ \t]*(.+)$/m);
  // The top-level version is a `Gem::Version` object: `version:` then an indented `version:`.
  const versionMatch = yaml.match(/^version:[^\n]*\n[ \t]+version:[ \t]*(.+)$/m);
  const name = nameMatch ? unquote(nameMatch[1] ?? "") : "";
  const version = versionMatch ? unquote(versionMatch[1] ?? "") : "";
  if (!name || !version) return null;

  const platform = (() => {
    const raw = yaml.match(/^platform:[ \t]*(.+)$/m)?.[1];
    const value = raw ? unquote(raw) : "";
    return value && value !== "ruby" ? value : undefined;
  })();

  return {
    name,
    version,
    ...(platform ? { platform } : {}),
    dependencies: parseDependencies(yaml),
  };
}
