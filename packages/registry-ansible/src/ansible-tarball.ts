import { gunzipSync } from "node:zlib";

/**
 * Minimal reader for an Ansible collection archive (a gzipped USTAR tar). We only
 * need the root `MANIFEST.json` entry, so the reader walks 512-byte tar headers
 * and returns the first matching member. No external tar dependency — only
 * node:zlib. Modeled on pub's tarball reader.
 */

const TAR_BLOCK = 512;

/**
 * Cap the gunzipped tar so a decompression bomb (a tiny gzip of repetitive bytes
 * expanding to hundreds of GB) can never be materialized in RAM and stall the
 * single Bun event loop. We only walk headers to find a small `MANIFEST.json`;
 * 16 MiB is generous for the tar that carries it.
 */
const MAX_COLLECTION_TAR_BYTES = 16 * 1024 * 1024;
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

/** Find the bytes of a member by path inside an (already gunzipped) tar buffer. */
export function readTarEntry(tar: Uint8Array, wantedPath: string): Uint8Array | null {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) break;
    const path = entryPath(header).replace(/^\.\//, "");
    const size = parseOctal(header.subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH));
    const dataStart = offset + TAR_BLOCK;
    if (dataStart + size > tar.length) break;
    if (path === wantedPath) return tar.subarray(dataStart, dataStart + size);
    // Advance past the data, rounded up to the next 512-byte boundary.
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

/** Gunzip a collection `.tar.gz` archive and return the `MANIFEST.json` text, if present. */
export function extractCollectionManifest(archive: Uint8Array): string | null {
  let tar: Uint8Array;
  try {
    // node:zlib enforces `maxOutputLength` (Bun.gunzipSync ignores it), so a
    // decompression bomb is rejected here rather than allocating unbounded and
    // stalling the single Bun event loop.
    tar = gunzipSync(archive, { maxOutputLength: MAX_COLLECTION_TAR_BYTES });
  } catch {
    return null;
  }
  const entry = readTarEntry(tar, "MANIFEST.json");
  return entry ? new TextDecoder().decode(entry) : null;
}
