import { inflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free reader for the top-level `Package.swift` manifest in
 * a SwiftPM source archive (a zip). We read the central directory — the
 * authoritative source of entry sizes/offsets — to locate and inflate the entry.
 */

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) |
    ((b[o + 1] ?? 0) << 8) |
    ((b[o + 2] ?? 0) << 16) |
    ((b[o + 3] ?? 0) * 0x1000000)) >>>
  0;

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * A source archive's entries are nested under a single top-level directory
 * (`<name>/Package.swift`), so we accept a manifest that is exactly one path
 * segment deep, or at the archive root.
 */
function isTopLevelManifest(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return /^(?:[^/]+\/)?Package\.swift$/i.test(normalized);
}

function inflateEntry(data: Uint8Array, method: number, expectedBytes: number): Uint8Array | null {
  if (expectedBytes > MAX_MANIFEST_BYTES) return null;
  if (method === 0) {
    return data.byteLength === expectedBytes && data.byteLength <= MAX_MANIFEST_BYTES ? data : null;
  }
  if (method !== 8) return null;
  try {
    const raw = inflateRawSync(data, {
      maxOutputLength: Math.min(expectedBytes + 1, MAX_MANIFEST_BYTES + 1),
    });
    return raw.byteLength === expectedBytes && raw.byteLength <= MAX_MANIFEST_BYTES ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Extract the text of the top-level `Package.swift` from a source archive, or
 * `null` when it can not be located/inflated. Never throws.
 */
export function extractPackageManifest(zip: Uint8Array): string | null {
  // Locate the End Of Central Directory record (scan back; comment ≤ 0xffff).
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
    if (!isTopLevelManifest(name)) continue;
    if (compSize > MAX_MANIFEST_BYTES || uncompSize > MAX_MANIFEST_BYTES) return null;
    if (u32(zip, localOff) !== 0x04034b50) return null;
    const dataStart = localOff + 30 + u16(zip, localOff + 26) + u16(zip, localOff + 28);
    if (dataStart > zip.byteLength || dataStart + compSize > zip.byteLength) return null;
    const data = zip.subarray(dataStart, dataStart + compSize);
    const raw = inflateEntry(data, method, uncompSize);
    return raw ? new TextDecoder().decode(raw) : null;
  }
  return null;
}
