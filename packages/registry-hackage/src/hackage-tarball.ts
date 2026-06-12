import { gunzipTar, tarMembers } from "@hootifactory/registry";

/**
 * Minimal USTAR tar reader/writer for Hackage. We read the `.cabal` member out
 * of an uploaded sdist (a gzipped tar rooted at `<name>-<version>/`) and write
 * the `01-index.tar.gz` (entries `<name>/<version>/<name>.cabal`). No external
 * tar dependency — only `node:zlib` for gunzip and `Bun.gzipSync` for gzip.
 */

const TAR_BLOCK = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;

/**
 * Cap the gunzipped sdist tar so a decompression bomb (a tiny gzip expanding to
 * many GB) can never be materialized in RAM and stall the single Bun event loop.
 * A sdist tar is small; 64 MiB is generous for locating its `.cabal`.
 */
const MAX_SDIST_TAR_BYTES = 64 * 1024 * 1024;

/**
 * Gunzip an sdist `.tar.gz` and return the top-level `.cabal` text. A Cabal
 * sdist is rooted at `<name>-<version>/`, with the package's `.cabal` directly
 * inside that directory (`<name>-<version>/<pkg>.cabal`). We return the first
 * `.cabal` at that single-nested depth.
 */
export function extractCabalFromSdist(
  archive: Uint8Array,
  options: { readonly maxTarBytes?: number } = {},
): string | null {
  // node:zlib enforces `maxOutputLength` (Bun.gunzipSync ignores it), so a
  // decompression bomb is rejected here rather than allocating unbounded.
  const tar = gunzipTar(archive, { maxTarBytes: options.maxTarBytes ?? MAX_SDIST_TAR_BYTES });
  if (!tar) return null;
  for (const member of tarMembers(tar)) {
    if (!member.path.toLowerCase().endsWith(".cabal")) continue;
    // Only accept the cabal directly under the single root directory:
    // `<root>/<pkg>.cabal` (exactly two path segments).
    if (member.path.split("/").length !== 2) continue;
    return new TextDecoder().decode(member.data);
  }
  return null;
}

const encoder = new TextEncoder();

/** Write one USTAR header + padded data block for a file member into `out`. */
function pushTarEntry(out: number[], name: string, data: Uint8Array): void {
  const header = new Uint8Array(TAR_BLOCK);
  const nameBytes = encoder.encode(name);
  // Names longer than 100 bytes would need the USTAR prefix split; index paths
  // (`<name>/<version>/<name>.cabal`) stay well within 100 bytes for our limits.
  header.set(nameBytes.subarray(0, TAR_NAME_LENGTH), TAR_NAME_OFFSET);
  writeOctal(header, 8, 100, 0o644); // mode
  writeOctal(header, 8, 108, 0); // uid
  writeOctal(header, 8, 116, 0); // gid
  writeOctal(header, TAR_SIZE_LENGTH, TAR_SIZE_OFFSET, data.length); // size
  writeOctal(header, 12, 136, 0); // mtime (deterministic)
  header[156] = 0x30; // typeflag '0' (regular file)
  // ustar magic + version
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  // Checksum: computed with the checksum field filled with spaces.
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumStr = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.set(encoder.encode(checksumStr), 148);

  for (const byte of header) out.push(byte);
  for (const byte of data) out.push(byte);
  const remainder = data.length % TAR_BLOCK;
  if (remainder !== 0) {
    for (let i = 0; i < TAR_BLOCK - remainder; i++) out.push(0);
  }
}

/** Write a left-padded, NUL-terminated octal field of `len` bytes at `offset`. */
function writeOctal(header: Uint8Array, len: number, offset: number, value: number): void {
  const str = `${value.toString(8).padStart(len - 1, "0")}\0`;
  header.set(encoder.encode(str), offset);
}

export interface IndexEntry {
  /** Repository-relative path `<name>/<version>/<name>.cabal`. */
  path: string;
  cabal: string;
}

/**
 * Build the uncompressed `01-index.tar` bytes from the index entries, in the
 * given (caller-sorted) order. Two zero blocks terminate the archive.
 */
export function buildIndexTar(entries: IndexEntry[]): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const entry of entries) {
    pushTarEntry(out, entry.path, encoder.encode(entry.cabal));
  }
  // Two trailing zero blocks mark end-of-archive.
  for (let i = 0; i < TAR_BLOCK * 2; i++) out.push(0);
  const buffer = new ArrayBuffer(out.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(out);
  return bytes;
}

/** Build the gzipped `01-index.tar.gz` bytes from the index entries. */
export function buildIndexTarGz(entries: IndexEntry[]): Uint8Array {
  return Bun.gzipSync(buildIndexTar(entries));
}
