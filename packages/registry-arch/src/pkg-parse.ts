import { zstdDecompressSync } from "node:zlib";
import { type ArchPkgInfo, parsePkgInfo } from "./arch-validation";

/**
 * Read the `.PKGINFO` from a pacman package archive
 * (`<name>-<ver>-<arch>.pkg.tar.{zst,xz}`). The package is a tar stream wrapped
 * in zstd (default) or xz; `.PKGINFO` is a plain-text member near the front.
 *
 * Clients upload only the binary package, so the identity/dependency metadata
 * must be recovered here. zstd is decompressed natively (Bun/node:zlib);
 * `xz`-compressed packages cannot be inflated here, so they report
 * `unsupported_compression` and the caller falls back to filename parsing.
 */

const MAX_TAR_BYTES = 16 * 1024 * 1024;
const MAX_TAR_ENTRIES = 512;

export type PkgInfoResult =
  | { ok: true; info: ArchPkgInfo }
  | { ok: false; reason: "malformed" | "unsupported_compression" };

/** Locate a file's bytes in an uncompressed tar stream by name (or null). */
function readTarFile(tar: Uint8Array, wanted: string[]): Uint8Array | null {
  let offset = 0;
  let scanned = 0;
  const decoder = new TextDecoder();
  while (offset + 512 <= tar.length && scanned < MAX_TAR_ENTRIES) {
    const header = tar.subarray(offset, offset + 512);
    // An all-zero block marks the end of the archive.
    if (header.every((byte) => byte === 0)) break;
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1;
    const name = decoder.decode(header.subarray(0, nameEnd));
    if (name === "") break;
    let sizeStr = "";
    for (let i = 124; i < 136; i += 1) {
      const code = header[i];
      if (code === undefined || code === 0 || code === 0x20) continue;
      sizeStr += String.fromCharCode(code);
    }
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
    const dataStart = offset + 512;
    if (!Number.isFinite(size) || size < 0 || dataStart + size > tar.length) break;
    if (wanted.includes(name)) return tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    scanned += 1;
  }
  return null;
}

/** Inflate the package's tar stream from its outer compression layer. */
function inflatePackage(bytes: Uint8Array): PkgInfoResult | { ok: true; tar: Uint8Array } {
  // xz magic: FD 37 7A 58 5A 00 ("\xFD7zXZ\0").
  const isXz =
    bytes.length >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00;
  if (isXz) return { ok: false, reason: "unsupported_compression" };
  try {
    const tar = zstdDecompressSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
    return { ok: true, tar: new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Extract and parse `.PKGINFO` from a pacman package archive. */
export function readPkgInfo(bytes: Uint8Array): PkgInfoResult {
  if (bytes.byteLength === 0) return { ok: false, reason: "malformed" };
  const inflated = inflatePackage(bytes);
  if (!("tar" in inflated)) return inflated;
  const pkginfo = readTarFile(inflated.tar, [".PKGINFO", "./.PKGINFO"]);
  if (!pkginfo) return { ok: false, reason: "malformed" };
  return { ok: true, info: parsePkgInfo(new TextDecoder().decode(pkginfo)) };
}
