import { inflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free reader for the `<id>`/`<version>` of a .nupkg's root
 * `.nuspec`. A .nupkg is a zip; we read the central directory (authoritative
 * sizes/offsets, unlike streamed local headers) to locate and inflate the entry.
 */

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) |
    ((b[o + 1] ?? 0) << 8) |
    ((b[o + 2] ?? 0) << 16) |
    ((b[o + 3] ?? 0) * 0x1000000)) >>>
  0;

function readNuspecXml(zip: Uint8Array): string | null {
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
  let p = u32(zip, eocd + 16); // central directory offset
  for (let n = 0; n < count; n++) {
    if (u32(zip, p) !== 0x02014b50) break;
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOff = u32(zip, p + 42);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^[^/]+\.nuspec$/i.test(name)) continue; // root-level *.nuspec only
    if (u32(zip, localOff) !== 0x04034b50) return null;
    const dataStart = localOff + 30 + u16(zip, localOff + 26) + u16(zip, localOff + 28);
    const data = zip.subarray(dataStart, dataStart + compSize);
    try {
      const raw = method === 0 ? data : inflateRawSync(data);
      return new TextDecoder().decode(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract id + version from a .nupkg's nuspec, or null if it can't be parsed. */
export function extractNuspecMeta(nupkg: Uint8Array): { id: string; version: string } | null {
  const xml = readNuspecXml(nupkg);
  if (!xml) return null;
  const id = xml.match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
  const version = xml.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
  if (!id || !version) return null;
  return { id: id.trim(), version: version.trim() };
}
