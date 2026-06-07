/**
 * LuaRocks manifest generation. A manifest is a Lua chunk assigning three
 * global tables — `repository`, `modules`, `commands` — which LuaRocks `load()`s
 * and reads. We regenerate it from the live versions on every request and emit
 * it as a Lua table literal (the only form LuaRocks consumes).
 *
 * The `repository` table maps each rock name to its versions, and each version
 * to a list of `{ arch = "<arch>", ... }` entries (`rockspec` for the rockspec,
 * `src`/`all`/`linux-x86_64`/... for rock archives), each carrying the parsed
 * `dependencies` so clients can resolve without fetching every rockspec. The
 * `modules` table (which maps the Lua module names a rock `require`s to its
 * providers) is left empty, matching real rock-server manifests — we do not
 * parse `build.modules` from rockspecs, so we cannot populate it reliably.
 */

import type { LuarocksVersionMeta } from "./luarocks-validation";

/** One published rock version with its available archs + dependencies. */
export interface ManifestVersionEntry {
  rock: string;
  version: string;
  /** arch tags present for this version, e.g. `["rockspec", "src"]`. */
  archs: string[];
  dependencies: string[];
}

/**
 * Build the Lua-table manifest body from the live version entries. Output is
 * deterministic (rocks, versions, and archs are sorted) so ETags are stable.
 */
export function buildLuarocksManifest(entries: ManifestVersionEntry[]): string {
  const byRock = new Map<string, ManifestVersionEntry[]>();
  for (const entry of entries) {
    const list = byRock.get(entry.rock) ?? [];
    list.push(entry);
    byRock.set(entry.rock, list);
  }

  const repository: LuaTable = {};
  for (const rock of [...byRock.keys()].sort(compare)) {
    const versions: LuaTable = {};
    const versionEntries = (byRock.get(rock) ?? []).sort((a, b) => compare(a.version, b.version));
    for (const entry of versionEntries) {
      const archList: LuaValue[] = [];
      for (const arch of [...new Set(entry.archs)].sort(compare)) {
        archList.push({
          arch,
          dependencies: entry.dependencies.length > 0 ? [...entry.dependencies] : undefined,
        });
      }
      versions[entry.version] = archList;
    }
    repository[rock] = versions;
  }

  const body =
    `${serializeAssignment("repository", repository)}\n` +
    `${serializeAssignment("modules", {})}\n` +
    `${serializeAssignment("commands", {})}\n`;
  return body;
}

/** Map a stored version's metadata into a manifest entry. */
export function versionEntryFromMeta(meta: LuarocksVersionMeta): ManifestVersionEntry | null {
  const archs = Object.keys(meta.blobs);
  if (archs.length === 0) return null;
  return {
    rock: meta.rock,
    version: meta.version,
    archs,
    dependencies: meta.dependencies ?? [],
  };
}

// --- Minimal Lua-table-literal serializer ------------------------------------

type LuaValue = string | number | boolean | LuaValue[] | LuaTable | undefined;
interface LuaTable {
  [key: string]: LuaValue;
}

function serializeAssignment(name: string, value: LuaValue): string {
  return `${name} = ${serializeValue(value, 0)}`;
}

function serializeValue(value: LuaValue, depth: number): string {
  if (value === undefined) return "nil";
  if (typeof value === "string") return quoteLuaString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return serializeArray(value, depth);
  return serializeTable(value, depth);
}

function serializeArray(values: LuaValue[], depth: number): string {
  if (values.length === 0) return "{}";
  const pad = indent(depth + 1);
  const items = values
    .filter((item) => item !== undefined)
    .map((item) => `${pad}${serializeValue(item, depth + 1)}`);
  return `{\n${items.join(",\n")}\n${indent(depth)}}`;
}

function serializeTable(table: LuaTable, depth: number): string {
  const keys = Object.keys(table).filter((key) => table[key] !== undefined);
  if (keys.length === 0) return "{}";
  const pad = indent(depth + 1);
  const items = keys.map(
    (key) => `${pad}${serializeKey(key)} = ${serializeValue(table[key], depth + 1)}`,
  );
  return `{\n${items.join(",\n")}\n${indent(depth)}}`;
}

/** Bare Lua identifier keys for valid identifiers; `["..."]` otherwise. */
function serializeKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `[${quoteLuaString(key)}]`;
}

function indent(depth: number): string {
  return "   ".repeat(depth);
}

/** Quote a Lua string literal, escaping backslashes, quotes and control chars. */
export function quoteLuaString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\${code}`;
    else out += ch;
  }
  return `${out}"`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
