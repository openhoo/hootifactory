import { inflateRawSync } from "node:zlib";

/**
 * Parse an Alpine `.apk` package. An `.apk` is several gzip members concatenated:
 * the signature tarball, the control tarball (which holds `.PKGINFO`), and the
 * (potentially large) data tarball. We iterate the gzip members one at a time and
 * stop at the control member — the one whose tar contains `.PKGINFO` — so the big
 * data segment is never decompressed. The `C:` index checksum is `Q1` + base64 of
 * the SHA1 of that control member's exact gzip bytes.
 */

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const GZIP_DEFLATE = 0x08;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;

export interface ApkPkgInfo {
  /** Raw `key = value` pairs; repeated keys (e.g. `depend`) keep the last value. */
  fields: Record<string, string>;
  name: string;
  version: string;
  arch: string;
  /**
   * Raw apk dependency tokens from `depend` lines, preserved verbatim. Conflict
   * markers (`!name`), version constraints (`foo>=1.0`), and namespaced provides
   * (`so:libz.so.1`, `pc:`, `cmd:`) are kept so the APKINDEX `D:` field carries
   * exactly what apk needs to resolve dependencies — a `!name` conflict must NOT
   * be reduced to a positive `name` dependency.
   */
  depends: string[];
  /**
   * Raw apk `provides` tokens (`so:libfoo.so.1`, `cmd:foo`, `foo=1.2.3-r0`),
   * emitted in the APKINDEX `p:` field so intra-repo dependency resolution works.
   */
  provides: string[];
  description: string | null;
  /** Compressed-package `size` from `.PKGINFO`: the uncompressed/installed size. */
  size: number | null;
}

export type ApkParseResult =
  | { ok: true; info: ApkPkgInfo; checksum: string }
  | { ok: false; reason: "malformed" | "missing_pkginfo" };

interface GzipMember {
  /** The member's full gzip bytes (header + deflate + 8-byte trailer). */
  bytes: Uint8Array;
  /** The decompressed member payload (here, a tar archive). */
  content: Uint8Array;
}

function isGzipHeader(buf: Uint8Array, offset: number): boolean {
  return (
    buf[offset] === GZIP_MAGIC_0 &&
    buf[offset + 1] === GZIP_MAGIC_1 &&
    buf[offset + 2] === GZIP_DEFLATE
  );
}

/** Length of a gzip member header (accounting for the optional FEXTRA/FNAME/... fields). */
function gzipHeaderLength(buf: Uint8Array, offset: number): number | null {
  if (offset + 10 > buf.length || !isGzipHeader(buf, offset)) return null;
  const flg = buf[offset + 3] ?? 0;
  let p = offset + 10;
  if (flg & 0x04) {
    // FEXTRA
    if (p + 2 > buf.length) return null;
    p += 2 + ((buf[p] ?? 0) | ((buf[p + 1] ?? 0) << 8));
  }
  if (flg & 0x08) {
    // FNAME (NUL-terminated)
    while (p < buf.length && buf[p] !== 0) p += 1;
    p += 1;
  }
  if (flg & 0x10) {
    // FCOMMENT (NUL-terminated)
    while (p < buf.length && buf[p] !== 0) p += 1;
    p += 1;
  }
  if (flg & 0x02) p += 2; // FHCRC
  return p <= buf.length ? p - offset : null;
}

/**
 * Inflate the gzip member at `offset` and return its exact byte range. The deflate
 * stream auto-terminates at its end marker, so `inflateRawSync` decompresses only
 * this member. The member end is the trailer position whose ISIZE matches the
 * inflated length and which is followed by EOF or the next member header.
 */
function readGzipMember(buf: Uint8Array, offset: number): GzipMember | null {
  const headerLen = gzipHeaderLength(buf, offset);
  if (headerLen === null) return null;
  const deflateStart = offset + headerLen;
  let content: Uint8Array;
  try {
    content = inflateRawSync(buf.subarray(deflateStart), { maxOutputLength: MAX_MEMBER_BYTES });
  } catch {
    return null;
  }
  const isize = content.length >>> 0;
  for (let probe = deflateStart; probe + 8 <= buf.length; probe += 1) {
    const gotIsize =
      ((buf[probe + 4] ?? 0) |
        ((buf[probe + 5] ?? 0) << 8) |
        ((buf[probe + 6] ?? 0) << 16) |
        ((buf[probe + 7] ?? 0) << 24)) >>>
      0;
    if (gotIsize !== isize) continue;
    const end = probe + 8;
    if (end !== buf.length && !isGzipHeader(buf, end)) continue;
    // Guard against a coincidental ISIZE match by re-inflating the exact slice.
    try {
      const check = inflateRawSync(buf.subarray(deflateStart, probe), {
        maxOutputLength: MAX_MEMBER_BYTES,
      });
      if (check.length === content.length) {
        return { bytes: buf.subarray(offset, end), content };
      }
    } catch {
      // Not a real boundary; keep probing.
    }
  }
  return null;
}

/** Locate a named file's bytes inside an (already decompressed) ustar archive. */
function readTarFile(tar: Uint8Array, wanted: string): Uint8Array | null {
  let offset = 0;
  let scanned = 0;
  while (offset + 512 <= tar.length && scanned < 4096) {
    const header = tar.subarray(offset, offset + 512);
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1;
    const name = new TextDecoder().decode(header.subarray(0, nameEnd));
    if (name === "") {
      offset += 512;
      scanned += 1;
      continue;
    }
    let sizeStr = "";
    for (let i = 124; i < 135; i += 1) {
      const code = header[i];
      if (code === undefined || code === 0 || code === 0x20) continue;
      sizeStr += String.fromCharCode(code);
    }
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
    const dataStart = offset + 512;
    if (!Number.isFinite(size) || size < 0 || dataStart + size > tar.length) break;
    if (name === wanted || name === `./${wanted}`) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
    scanned += 1;
  }
  return null;
}

/** SHA1, base64-encoded, prefixed with apk's `Q1` checksum tag. */
function q1Checksum(bytes: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha1").update(bytes).digest("base64");
  return `Q1${hash}`;
}

/** Parse `.PKGINFO` `key = value` lines; repeated keys collapse to the last. */
export function parsePkgInfo(text: string): ApkPkgInfo {
  const fields: Record<string, string> = {};
  const depends: string[] = [];
  const provides: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "") continue;
    fields[key] = value;
    // Preserve the raw apk token verbatim: a `!name` conflict, a versioned
    // constraint (`foo>=1.0`), or a namespaced provide (`so:libz.so.1`) must
    // survive into the APKINDEX so apk resolves dependencies correctly.
    if (key === "depend" && value !== "") depends.push(value);
    if (key === "provides" && value !== "") provides.push(value);
  }
  const size = fields.size !== undefined ? Number.parseInt(fields.size, 10) : Number.NaN;
  return {
    fields,
    name: fields.pkgname ?? "",
    version: fields.pkgver ?? "",
    arch: fields.arch ?? "",
    depends,
    provides,
    description: fields.pkgdesc ?? null,
    size: Number.isFinite(size) ? size : null,
  };
}

export function parseApk(bytes: Uint8Array): ApkParseResult {
  if (bytes.length < 3 || !isGzipHeader(bytes, 0)) {
    return { ok: false, reason: "malformed" };
  }

  // Walk gzip members until the one whose tar holds `.PKGINFO` (the control
  // segment). Stopping there means the large data member is never inflated.
  let offset = 0;
  let scanned = 0;
  while (offset < bytes.length && scanned < 8) {
    const member = readGzipMember(bytes, offset);
    if (!member) break;
    const pkginfo = readTarFile(member.content, ".PKGINFO");
    if (pkginfo) {
      const info = parsePkgInfo(new TextDecoder().decode(pkginfo));
      if (info.name === "" || info.version === "" || info.arch === "") {
        return { ok: false, reason: "missing_pkginfo" };
      }
      return { ok: true, info, checksum: q1Checksum(member.bytes) };
    }
    if (member.bytes.length === 0) break;
    offset += member.bytes.length;
    scanned += 1;
  }
  return { ok: false, reason: "missing_pkginfo" };
}
