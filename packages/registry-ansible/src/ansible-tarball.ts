import { readGzipTarEntryText, readTarEntry } from "@hootifactory/registry";

export { readTarEntry };

/**
 * Minimal reader for an Ansible collection archive (a gzipped USTAR tar). We only
 * need the root `MANIFEST.json` entry, so the reader walks 512-byte tar headers
 * and returns the first matching member. No external tar dependency — only
 * node:zlib. Modeled on pub's tarball reader.
 */

/**
 * Cap the gunzipped tar so a decompression bomb (a tiny gzip of repetitive bytes
 * expanding to hundreds of GB) can never be materialized in RAM and stall the
 * single Bun event loop. We only walk headers to find a small `MANIFEST.json`;
 * 16 MiB is generous for the tar that carries it.
 */
const MAX_COLLECTION_TAR_BYTES = 16 * 1024 * 1024;

/** Gunzip a collection `.tar.gz` archive and return the `MANIFEST.json` text, if present. */
export function extractCollectionManifest(archive: Uint8Array): string | null {
  // node:zlib enforces `maxOutputLength` (Bun.gunzipSync ignores it), so a
  // decompression bomb is rejected here rather than allocating unbounded and
  // stalling the single Bun event loop.
  return readGzipTarEntryText(archive, "MANIFEST.json", {
    maxTarBytes: MAX_COLLECTION_TAR_BYTES,
  });
}
