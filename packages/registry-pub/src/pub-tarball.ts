import { gunzipSync } from "node:zlib";

/**
 * Minimal reader for a pub package archive (a gzipped USTAR tar). We only need
 * the `pubspec.yaml` entry, so the reader walks 512-byte tar headers and returns
 * the first matching member. No external tar/yaml dependency — only node:zlib.
 */

const TAR_BLOCK = 512;

/**
 * Cap the gunzipped tar so a decompression bomb (a tiny gzip of repetitive bytes
 * expanding to hundreds of GB) can never be materialized in RAM and stall the
 * single Bun event loop. A `pubspec.yaml` is a few hundred bytes; 8 MiB is
 * generous for the small tar that carries it. Matches APT's `MAX_CONTROL_TAR_BYTES`.
 */
const MAX_PUB_TAR_BYTES = 8 * 1024 * 1024;
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

/** Gunzip a `.tar.gz` archive and return the `pubspec.yaml` text, if present. */
export function extractPubspecYaml(archive: Uint8Array): string | null {
  let tar: Uint8Array;
  try {
    // node:zlib enforces `maxOutputLength` (Bun.gunzipSync ignores it), so a
    // decompression bomb is rejected here rather than allocating unbounded and
    // stalling the single Bun event loop.
    tar = gunzipSync(archive, { maxOutputLength: MAX_PUB_TAR_BYTES });
  } catch {
    return null;
  }
  const entry = readTarEntry(tar, "pubspec.yaml");
  return entry ? new TextDecoder().decode(entry) : null;
}
