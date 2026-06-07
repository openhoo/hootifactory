import { gunzipSync } from "node:zlib";

/**
 * Minimal reader for a CRAN source package (`<pkg>_<version>.tar.gz`, a gzipped
 * USTAR tar). A source package's top directory is the package name and carries a
 * `DESCRIPTION` control file; we only need that member, so the reader walks
 * 512-byte tar headers and returns the first top-level `DESCRIPTION` entry. No
 * external tar dependency — only node:zlib.
 */

const TAR_BLOCK = 512;

/**
 * Cap the gunzipped tar so a decompression bomb (a tiny gzip of repetitive bytes
 * expanding to hundreds of GB) can never be materialized in RAM and stall the
 * single Bun event loop. node:zlib enforces `maxOutputLength` (Bun.gunzipSync
 * ignores it). A DESCRIPTION is a few KiB; 16 MiB is generous for the tar prefix
 * that carries it before the package's source files.
 */
const MAX_CRAN_TAR_BYTES = 16 * 1024 * 1024;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;

function decodeCString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  return new TextDecoder().decode(slice);
}

/** Parse an octal tar numeric field (space/NUL terminated). */
function parseOctal(bytes: Uint8Array): number {
  const text = decodeCString(bytes).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Read the full path of a USTAR entry, honoring the `prefix` field. */
function entryPath(header: Uint8Array): string {
  const name = decodeCString(header.subarray(TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_LENGTH));
  const prefix = decodeCString(
    header.subarray(TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_LENGTH),
  );
  return prefix ? `${prefix}/${name}` : name;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * Find the first member whose path is `<top>/DESCRIPTION` (the package's root
 * DESCRIPTION) inside an already-gunzipped tar buffer. Only a top-level
 * DESCRIPTION (exactly one path segment before the filename) is accepted so a
 * nested `inst/.../DESCRIPTION` in test fixtures cannot be mistaken for it.
 */
function readDescription(tar: Uint8Array): Uint8Array | null {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) break;
    const path = entryPath(header).replace(/^\.\//, "");
    const size = parseOctal(header.subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH));
    const dataStart = offset + TAR_BLOCK;
    if (dataStart + size > tar.length) break;
    const segments = path.split("/");
    if (segments.length === 2 && segments[1] === "DESCRIPTION") {
      return tar.subarray(dataStart, dataStart + size);
    }
    // Advance past the data, rounded up to the next 512-byte boundary.
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

/** Gunzip a `.tar.gz` source package and return the `DESCRIPTION` text, if present. */
export function extractCranDescription(archive: Uint8Array): string | null {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_CRAN_TAR_BYTES });
  } catch {
    return null;
  }
  const entry = readDescription(tar);
  return entry ? new TextDecoder().decode(entry) : null;
}
