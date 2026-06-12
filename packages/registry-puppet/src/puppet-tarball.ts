import {
  readGzipTarEntryByBasenameText,
  readTarEntryByBasename as readSdkTarEntryByBasename,
} from "@hootifactory/registry";

/**
 * Minimal reader for a Puppet module archive (a gzipped USTAR tar). A Puppet
 * module tarball wraps its files under a single top-level directory named
 * `<owner>-<name>-<version>/`, so `metadata.json` lives at
 * `<owner>-<name>-<version>/metadata.json`. We walk 512-byte tar headers and
 * return the first `metadata.json` member regardless of its parent directory. No
 * external tar/gzip dependency — only node:zlib.
 */

/**
 * Cap the gunzipped tar so a decompression bomb (a tiny gzip of repetitive bytes
 * expanding to hundreds of GB) can never be materialized in RAM and stall the
 * single Bun event loop. A `metadata.json` is a few KiB; 8 MiB is generous for
 * the small tar that carries it. Matches APT's `MAX_CONTROL_TAR_BYTES` and pub's
 * `MAX_PUB_TAR_BYTES`.
 */
const MAX_PUPPET_TAR_BYTES = 8 * 1024 * 1024;

/**
 * Cap how many tar headers we walk before giving up. A crafted tar (within the
 * allowed size) could pack hundreds of thousands of tiny entries into a tight
 * scan loop; metadata.json lives near the archive root, so 256 entries is more
 * than enough. Matches APT's `scanned < 256` guard.
 */
const MAX_TAR_ENTRIES = 256;

/**
 * Find the bytes of the first tar member whose basename matches `wantedBasename`
 * (e.g. `metadata.json`) inside an already-gunzipped tar buffer.
 */
export function readTarEntryByBasename(tar: Uint8Array, wantedBasename: string): Uint8Array | null {
  return readSdkTarEntryByBasename(tar, wantedBasename, { maxEntries: MAX_TAR_ENTRIES });
}

/** Gunzip a `.tar.gz` module archive and return the `metadata.json` text, if present. */
export function extractPuppetMetadataJson(archive: Uint8Array): string | null {
  // node:zlib enforces `maxOutputLength` (Bun.gunzipSync ignores it), so a
  // decompression bomb is rejected here rather than allocating unbounded and
  // stalling the single Bun event loop.
  return readGzipTarEntryByBasenameText(archive, "metadata.json", {
    maxEntries: MAX_TAR_ENTRIES,
    maxTarBytes: MAX_PUPPET_TAR_BYTES,
  });
}
