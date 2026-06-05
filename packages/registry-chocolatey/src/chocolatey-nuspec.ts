import { inflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free reader for the root `.nuspec` metadata in a .nupkg
 * (which is a zip). We walk the central directory — authoritative for
 * sizes/offsets, unlike streamed local headers — to locate and inflate the
 * single root-level `*.nuspec` entry. Replicated locally so the plugin imports
 * only the registry SDK.
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
const MAX_NUSPEC_BYTES = 1024 * 1024;

function inflateNuspecData(
  data: Uint8Array,
  method: number,
  expectedBytes: number,
): Uint8Array | null {
  if (expectedBytes > MAX_NUSPEC_BYTES) return null;
  if (method === 0) {
    if (data.byteLength > MAX_NUSPEC_BYTES || data.byteLength !== expectedBytes) return null;
    return data;
  }
  if (method !== 8) return null;
  try {
    const raw = inflateRawSync(data, {
      maxOutputLength: Math.min(expectedBytes + 1, MAX_NUSPEC_BYTES + 1),
    });
    return raw.byteLength === expectedBytes && raw.byteLength <= MAX_NUSPEC_BYTES ? raw : null;
  } catch {
    return null;
  }
}

function readNuspecXml(zip: Uint8Array): string | null {
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
    const uncompSize = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOff = u32(zip, p + 42);
    if (compSize > MAX_NUSPEC_BYTES || uncompSize > MAX_NUSPEC_BYTES) return null;
    if (p + 46 + nameLen + extraLen + commentLen > zip.byteLength) return null;
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^[^/]+\.nuspec$/i.test(name)) continue; // root-level *.nuspec only
    if (u32(zip, localOff) !== 0x04034b50) return null;
    const dataStart = localOff + 30 + u16(zip, localOff + 26) + u16(zip, localOff + 28);
    if (dataStart > zip.byteLength || dataStart + compSize > zip.byteLength) return null;
    const data = zip.subarray(dataStart, dataStart + compSize);
    const raw = inflateNuspecData(data, method, uncompSize);
    return raw ? new TextDecoder().decode(raw) : null;
  }
  return null;
}

export interface NuspecDependency {
  id: string;
  range: string;
}

export interface NuspecMeta {
  id: string;
  version: string;
  title?: string;
  authors?: string;
  description?: string;
  tags?: string;
  dependencies: NuspecDependency[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isAttrNameStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x3a
  );
}

function isAttrNameChar(code: number): boolean {
  return isAttrNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2d;
}

function attrMap(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let cursor = 0;
  while (cursor < tag.length) {
    if (!isAttrNameStart(tag.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    cursor += 1;
    while (cursor < tag.length && isAttrNameChar(tag.charCodeAt(cursor))) cursor += 1;
    const name = tag.slice(nameStart, cursor).toLowerCase();

    while (cursor < tag.length && isXmlWhitespace(tag.charCodeAt(cursor))) cursor += 1;
    if (tag.charCodeAt(cursor) !== 0x3d) continue;
    cursor += 1;
    while (cursor < tag.length && isXmlWhitespace(tag.charCodeAt(cursor))) cursor += 1;

    const quote = tag.charCodeAt(cursor);
    if (quote !== 0x22 && quote !== 0x27) {
      cursor += 1;
      continue;
    }
    const valueStart = cursor + 1;
    const valueEnd = tag.indexOf(String.fromCharCode(quote), valueStart);
    if (valueEnd < 0) break;
    attrs[name] = decodeXml(tag.slice(valueStart, valueEnd));
    cursor = valueEnd + 1;
  }
  return attrs;
}

function dependencyFromTag(tag: string): NuspecDependency | null {
  const attrs = attrMap(tag);
  const id = attrs.id?.trim();
  const range = attrs.version?.trim();
  if (!id) return null;
  return { id, range: range || "" };
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

function parseDependencies(xml: string): NuspecDependency[] | null {
  let inDependencies = false;
  const dependencies: NuspecDependency[] = [];
  let processedDependencyTags = 0;

  for (const tag of scanXmlTags(xml)) {
    if (!inDependencies) {
      if (!tag.closing && tag.name === "dependencies") inDependencies = true;
      continue;
    }
    if (tag.closing && tag.name === "dependencies") break;
    if (!tag.closing && tag.name === "dependency") {
      processedDependencyTags += 1;
      if (processedDependencyTags > MAX_NUSPEC_DEPENDENCIES) return null;
      const dep = dependencyFromTag(tag.source);
      if (dep) dependencies.push(dep);
    }
  }
  return dependencies;
}

function readSimpleTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, "i").exec(xml);
  const value = match?.[1];
  return value ? decodeXml(value) : undefined;
}

/** Extract Chocolatey/NuGet package metadata from a .nupkg's nuspec, or null. */
export function extractNuspecMeta(nupkg: Uint8Array): NuspecMeta | null {
  const xml = readNuspecXml(nupkg);
  if (!xml) return null;
  const id = xml.match(/<id>\s*([^<]+?)\s*<\/id>/i)?.[1];
  const version = xml.match(/<version>\s*([^<]+?)\s*<\/version>/i)?.[1];
  if (!id || !version) return null;
  const dependencies = parseDependencies(xml);
  if (!dependencies) return null;
  return {
    id: id.trim(),
    version: version.trim(),
    title: readSimpleTag(xml, "title"),
    authors: readSimpleTag(xml, "authors"),
    description: readSimpleTag(xml, "description"),
    tags: readSimpleTag(xml, "tags"),
    dependencies,
  };
}
