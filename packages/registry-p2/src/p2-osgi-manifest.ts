import { inflateRawSync } from "node:zlib";

/**
 * Dependency-free reader for the OSGi `META-INF/MANIFEST.MF` inside an uploaded
 * bundle/feature jar. A jar is a zip; we read the central directory
 * (authoritative sizes/offsets, unlike streamed local headers) to locate and
 * inflate the manifest entry. Mirrors the NuGet `.nuspec` / Composer readers.
 */

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) |
    ((b[o + 1] ?? 0) << 8) |
    ((b[o + 2] ?? 0) << 16) |
    ((b[o + 3] ?? 0) * 0x1000000)) >>>
  0;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_PATH = "META-INF/MANIFEST.MF";

function inflateEntry(data: Uint8Array, method: number, expectedBytes: number): Uint8Array | null {
  if (expectedBytes > MAX_MANIFEST_BYTES) return null;
  if (method === 0) {
    return data.byteLength === expectedBytes ? data : null;
  }
  if (method !== 8) return null;
  try {
    const raw = inflateRawSync(data, {
      maxOutputLength: Math.min(expectedBytes + 1, MAX_MANIFEST_BYTES + 1),
    });
    return raw.byteLength === expectedBytes ? raw : null;
  } catch {
    return null;
  }
}

/** Locate and inflate `META-INF/MANIFEST.MF` from a jar, reading the central directory. */
function readManifestBytes(zip: Uint8Array): Uint8Array | null {
  // Locate the End Of Central Directory record (scan back; comment <= 0xffff).
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
    if (p + 46 + nameLen + extraLen + commentLen > zip.byteLength) return null;
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    // Jar manifest paths are case-insensitive in practice; match accordingly.
    if (name.toUpperCase() !== MANIFEST_PATH) continue;
    if (compSize > MAX_MANIFEST_BYTES || uncompSize > MAX_MANIFEST_BYTES) return null;
    if (u32(zip, localOff) !== 0x04034b50) return null;
    const dataStart = localOff + 30 + u16(zip, localOff + 26) + u16(zip, localOff + 28);
    if (dataStart > zip.byteLength || dataStart + compSize > zip.byteLength) return null;
    return inflateEntry(zip.subarray(dataStart, dataStart + compSize), method, uncompSize);
  }
  return null;
}

/**
 * Parse the `name: value` headers of a MANIFEST.MF, unfolding RFC822-style
 * continuation lines (a leading single space continues the previous header).
 * Header names are returned lower-cased for case-insensitive lookup.
 */
export function parseManifestHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Manifests use CRLF line endings; tolerate bare LF.
  const lines = text.split(/\r\n|\r|\n/);
  let currentName: string | null = null;
  let currentValue = "";
  const flush = () => {
    if (currentName !== null) headers.set(currentName, currentValue);
    currentName = null;
    currentValue = "";
  };
  for (const line of lines) {
    if (line.startsWith(" ")) {
      // Continuation of the previous header value.
      if (currentName !== null) currentValue += line.slice(1);
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    currentName = line.slice(0, colon).trim().toLowerCase();
    currentValue = line.slice(colon + 1).trim();
  }
  flush();
  return headers;
}

export interface OsgiManifest {
  /** Bundle-SymbolicName with any directives/attributes (e.g. `;singleton:=true`) stripped. */
  symbolicName: string;
  /** Bundle-Version, normalized to an OSGi version with no leading/trailing whitespace. */
  version: string;
}

/**
 * Strip trailing OSGi directives/attributes from a header value, returning just
 * the leading token (e.g. `org.example.bundle;singleton:=true` -> `org.example.bundle`).
 */
function leadingToken(value: string): string {
  const semicolon = value.indexOf(";");
  return (semicolon < 0 ? value : value.slice(0, semicolon)).trim();
}

const SYMBOLIC_NAME_RE = /^[A-Za-z0-9._-]+$/;
// OSGi versions: major[.minor[.micro[.qualifier]]]; qualifier is [A-Za-z0-9_-]+.
const OSGI_VERSION_RE = /^\d+(\.\d+(\.\d+(\.[A-Za-z0-9_-]+)?)?)?$/;

/**
 * Extract the OSGi coordinates (Bundle-SymbolicName + Bundle-Version) from a
 * bundle/feature jar's manifest. Returns null when the jar has no parseable
 * manifest or is missing the required headers.
 */
export function parseOsgiManifest(jar: Uint8Array): OsgiManifest | null {
  const bytes = readManifestBytes(jar);
  if (!bytes) return null;
  const headers = parseManifestHeaders(new TextDecoder().decode(bytes));
  const rawSymbolic = headers.get("bundle-symbolicname");
  if (!rawSymbolic) return null;
  const symbolicName = leadingToken(rawSymbolic);
  // Bundle-Version is optional in OSGi (defaults to 0.0.0).
  const version = (headers.get("bundle-version") ?? "0.0.0").trim();
  if (!SYMBOLIC_NAME_RE.test(symbolicName)) return null;
  if (!OSGI_VERSION_RE.test(version)) return null;
  return { symbolicName, version };
}
