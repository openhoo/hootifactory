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

const MAX_NUSPEC_TAG_CHARS = 16 * 1024;
const MAX_NUSPEC_DEPENDENCIES = 512;

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

interface ScannedTag {
  name: string;
  source: string;
  closing: boolean;
  selfClosing: boolean;
}

function* scanXmlTags(xml: string): Generator<ScannedTag> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) return;
    const end = xml.indexOf(">", start + 1);
    if (end < 0) return;
    cursor = end + 1;

    if (end - start + 1 > MAX_NUSPEC_TAG_CHARS) continue;
    const body = xml.slice(start + 1, end).trim();
    if (!body || body.startsWith("!") || body.startsWith("?")) continue;

    const closing = body.startsWith("/");
    const tagBody = (closing ? body.slice(1) : body).trimStart();
    const nameEnd = tagBody.search(/[\s/>]/);
    const name = tagBody.slice(0, nameEnd < 0 ? undefined : nameEnd).toLowerCase();
    if (!name) continue;

    yield {
      name,
      source: `<${body}>`,
      closing,
      selfClosing: !closing && tagBody.endsWith("/"),
    };
  }
}

function parseDependencies(xml: string): NuspecDependencyGroup[] | null {
  let inDependencies = false;
  let dependencyCount = 0;
  const directDependencies: NuspecDependency[] = [];
  const groups: NuspecDependencyGroup[] = [];
  let currentGroup: NuspecDependencyGroup | null = null;

  const addDependency = (dep: NuspecDependency | null): boolean => {
    if (!dep) return true;
    dependencyCount += 1;
    if (dependencyCount > MAX_NUSPEC_DEPENDENCIES) return false;
    (currentGroup?.dependencies ?? directDependencies).push(dep);
    return true;
  };

  for (const tag of scanXmlTags(xml)) {
    if (!inDependencies) {
      if (!tag.closing && tag.name === "dependencies") inDependencies = true;
      continue;
    }

    if (tag.closing && tag.name === "dependencies") break;

    if (!tag.closing && tag.name === "group") {
      const attrs = attrMap(tag.source);
      currentGroup = {
        ...(attrs.targetframework ? { targetFramework: attrs.targetframework } : {}),
        dependencies: [],
      };
      if (tag.selfClosing) currentGroup = null;
      continue;
    }

    if (tag.closing && tag.name === "group") {
      if (currentGroup?.dependencies.length) groups.push(currentGroup);
      currentGroup = null;
      continue;
    }

    if (
      !tag.closing &&
      tag.name === "dependency" &&
      !addDependency(dependencyFromTag(tag.source))
    ) {
      return null;
    }
  }

  if (directDependencies.length > 0) groups.unshift({ dependencies: directDependencies });
  return groups;
}

/** Extract NuGet package metadata from a .nupkg's nuspec, or null if it can't be parsed. */
export function extractNuspecMeta(nupkg: Uint8Array): NuspecMeta | null {
  const xml = readNuspecXml(nupkg);
  if (!xml) return null;
  const id = xml.match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
  const version = xml.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
  if (!id || !version) return null;
  const dependencyGroups = parseDependencies(xml);
  if (!dependencyGroups) return null;
  return { id: id.trim(), version: version.trim(), dependencyGroups };
}
