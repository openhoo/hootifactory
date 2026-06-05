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

function fieldValue(line: string, key: string): string | null {
  if (!line.startsWith(`${key}:`)) return null;
  return line.slice(key.length + 1).trim();
}

/** Lines belonging to a top-level `key:` block (everything until the next top-level key). */
function topLevelSection(yaml: string, key: string): string | null {
  const lines = yaml.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (fieldValue(line, key) !== null) inSection = true;
      continue;
    }
    if (line.length > 0 && line[0] !== " " && line[0] !== "\t" && line[0] !== "-") break;
    out.push(line);
  }
  return inSection ? out.join("\n") : null;
}

function parseConstraints(section: string): string {
  const operators: string[] = [];
  const versions: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- - ")) {
      const op = unquote(trimmed.slice(4));
      if (/^[><=~!]+$/.test(op)) operators.push(op);
      continue;
    }
    const value = fieldValue(trimmed, "version");
    if (value !== null) versions.push(unquote(value));
  }
  const parts = operators.map((op, i) => `${op} ${versions[i] ?? "0"}`);
  return parts.length > 0 ? parts.join("&") : ">= 0";
}

function parseDependencies(yaml: string): GemDependency[] {
  const body = topLevelSection(yaml, "dependencies");
  if (!body) return [];
  const deps: GemDependency[] = [];
  for (const chunk of body.split(/\n(?=- )/)) {
    if (!/Gem::Dependency/.test(chunk)) continue;
    const name = chunk
      .split("\n")
      .map((line) => fieldValue(line.trim(), "name"))
      .find((value): value is string => value !== null);
    if (!name) continue;
    const type =
      chunk
        .split("\n")
        .map((line) => fieldValue(line.trim(), "type"))
        .find((value): value is string => value !== null)
        ?.replace(/^:/, "") ?? "runtime";
    if (type !== "runtime") continue;
    // The `requirement:` block precedes `type:`; `version_requirements:` follows it.
    const reqLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (fieldValue(line.trim(), "type") !== null) break;
      reqLines.push(line);
    }
    const reqSection = reqLines.join("\n");
    deps.push({ name: unquote(name), requirements: parseConstraints(reqSection) });
  }
  return deps;
}

export function parseGemspecYaml(yaml: string): GemMetadata | null {
  let name = "";
  let version = "";
  let platform = "";
  let sawTopLevelVersion = false;
  for (const line of yaml.split("\n")) {
    if (line.length === 0) continue;
    const topLevel = line[0] !== " " && line[0] !== "\t" && line[0] !== "-";
    if (topLevel) {
      sawTopLevelVersion = fieldValue(line, "version") !== null;
      const nameValue = fieldValue(line, "name");
      if (nameValue !== null) name = unquote(nameValue);
      const platformValue = fieldValue(line, "platform");
      if (platformValue !== null) platform = unquote(platformValue);
      continue;
    }
    if (sawTopLevelVersion) {
      const versionValue = fieldValue(line.trim(), "version");
      if (versionValue !== null) {
        version = unquote(versionValue);
        sawTopLevelVersion = false;
      }
    }
  }
  if (!name || !version) return null;

  return {
    name,
    version,
    ...(platform && platform !== "ruby" ? { platform } : {}),
    dependencies: parseDependencies(yaml),
  };
}
