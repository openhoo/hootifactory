import { inflateRawSync } from "node:zlib";

/**
 * Dependency-free reader for the shallowest `composer.json` inside an uploaded
 * zip. A Composer dist is a zip; we read the central directory (authoritative
 * sizes/offsets) to locate and inflate the entry. Mirrors the NuGet `.nuspec`
 * reader.
 */

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) |
    ((b[o + 1] ?? 0) << 8) |
    ((b[o + 2] ?? 0) << 16) |
    ((b[o + 3] ?? 0) * 0x1000000)) >>>
  0;

const MAX_COMPOSER_JSON_BYTES = 1024 * 1024;

function inflateEntry(data: Uint8Array, method: number, expectedBytes: number): Uint8Array | null {
  if (expectedBytes > MAX_COMPOSER_JSON_BYTES) return null;
  if (method === 0) {
    return data.byteLength === expectedBytes ? data : null;
  }
  if (method !== 8) return null;
  try {
    const raw = inflateRawSync(data, {
      maxOutputLength: Math.min(expectedBytes + 1, MAX_COMPOSER_JSON_BYTES + 1),
    });
    return raw.byteLength === expectedBytes ? raw : null;
  } catch {
    return null;
  }
}

function depth(name: string): number {
  return name.split("/").length;
}

function readComposerJsonBytes(zip: Uint8Array): Uint8Array | null {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  // Pick the shallowest `composer.json` (root level beats a nested copy).
  let best: {
    method: number;
    compSize: number;
    uncompSize: number;
    localOff: number;
    depth: number;
  } | null = null;
  for (let n = 0; n < count; n++) {
    if (u32(zip, p) !== 0x02014b50) break;
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const uncompSize = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOff = u32(zip, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > zip.byteLength) return null;
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (
      (name === "composer.json" || name.endsWith("/composer.json")) &&
      compSize <= MAX_COMPOSER_JSON_BYTES &&
      uncompSize <= MAX_COMPOSER_JSON_BYTES &&
      (!best || depth(name) < best.depth)
    ) {
      best = { method, compSize, uncompSize, localOff, depth: depth(name) };
    }
  }
  if (!best) return null;
  if (u32(zip, best.localOff) !== 0x04034b50) return null;
  const dataStart =
    best.localOff + 30 + u16(zip, best.localOff + 26) + u16(zip, best.localOff + 28);
  if (dataStart + best.compSize > zip.byteLength) return null;
  return inflateEntry(
    zip.subarray(dataStart, dataStart + best.compSize),
    best.method,
    best.uncompSize,
  );
}

export interface ComposerManifest {
  name?: string;
  version?: string;
  type?: string;
  require?: Record<string, string>;
}

/** Extract the parsed root `composer.json` from a dist zip, or null. */
export function readComposerManifest(zip: Uint8Array): ComposerManifest | null {
  const bytes = readComposerJsonBytes(zip);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const require: Record<string, string> = {};
  if (record.require && typeof record.require === "object") {
    for (const [key, value] of Object.entries(record.require as Record<string, unknown>)) {
      if (typeof value === "string") require[key] = value;
    }
  }
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(Object.keys(require).length > 0 ? { require } : {}),
  };
}
