import { inflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free reader for the root `.nuspec` metadata in a .nupkg.
 * A .nupkg is a zip; we read the central directory (authoritative sizes/offsets,
 * unlike streamed local headers) to locate and inflate the entry.
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

export interface NuspecDependency {
  id: string;
  range: string;
  include?: string;
  exclude?: string;
}

export interface NuspecDependencyGroup {
  targetFramework?: string;
  dependencies: NuspecDependency[];
}

export interface NuspecMeta {
  id: string;
  version: string;
  dependencyGroups: NuspecDependencyGroup[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrMap(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]!.toLowerCase()] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function dependencyFromTag(tag: string): NuspecDependency | null {
  const attrs = attrMap(tag);
  const id = attrs.id?.trim();
  const range = attrs.version?.trim();
  if (!id || !range) return null;
  return {
    id,
    range,
    ...(attrs.include ? { include: attrs.include } : {}),
    ...(attrs.exclude ? { exclude: attrs.exclude } : {}),
  };
}

function parseDependencies(xml: string): NuspecDependencyGroup[] {
  const depsXml = xml.match(/<dependencies\b[^>]*>([\s\S]*?)<\/dependencies>/i)?.[1];
  if (!depsXml) return [];

  const groups: NuspecDependencyGroup[] = [];
  const groupRanges: [number, number][] = [];
  for (const match of depsXml.matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/gi)) {
    groupRanges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    const attrs = attrMap(match[1] ?? "");
    const dependencies = [...(match[2] ?? "").matchAll(/<dependency\b[^>]*\/?>/gi)]
      .map((dep) => dependencyFromTag(dep[0]))
      .filter((dep): dep is NuspecDependency => dep != null);
    groups.push({
      ...(attrs.targetframework ? { targetFramework: attrs.targetframework } : {}),
      dependencies,
    });
  }

  const directXml = groupRanges.reduce(
    (source, [start, end]) =>
      `${source.slice(0, start)}${" ".repeat(end - start)}${source.slice(end)}`,
    depsXml,
  );
  const directDependencies = [...directXml.matchAll(/<dependency\b[^>]*\/?>/gi)]
    .map((dep) => dependencyFromTag(dep[0]))
    .filter((dep): dep is NuspecDependency => dep != null);
  if (directDependencies.length > 0) groups.unshift({ dependencies: directDependencies });

  return groups.filter((group) => group.dependencies.length > 0);
}

/** Extract NuGet package metadata from a .nupkg's nuspec, or null if it can't be parsed. */
export function extractNuspecMeta(nupkg: Uint8Array): NuspecMeta | null {
  const xml = readNuspecXml(nupkg);
  if (!xml) return null;
  const id = xml.match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
  const version = xml.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
  if (!id || !version) return null;
  return { id: id.trim(), version: version.trim(), dependencyGroups: parseDependencies(xml) };
}
