import { readGzipTarEntryText, readTarEntry } from "@hootifactory/registry";

export { readTarEntry };

/**
 * Minimal reader for a pub package archive (a gzipped USTAR tar). We only need
 * the `pubspec.yaml` entry, so the reader walks 512-byte tar headers and returns
 * the first matching member. No external tar/yaml dependency — only node:zlib.
 */

/**
 * Cap the gunzipped tar so a decompression bomb (a tiny gzip of repetitive bytes
 * expanding to hundreds of GB) can never be materialized in RAM and stall the
 * single Bun event loop. A `pubspec.yaml` is a few hundred bytes; 8 MiB is
 * generous for the small tar that carries it. Matches APT's `MAX_CONTROL_TAR_BYTES`.
 */
const MAX_PUB_TAR_BYTES = 8 * 1024 * 1024;

/** Gunzip a `.tar.gz` archive and return the `pubspec.yaml` text, if present. */
export function extractPubspecYaml(archive: Uint8Array): string | null {
  // node:zlib enforces `maxOutputLength` (Bun.gunzipSync ignores it), so a
  // decompression bomb is rejected here rather than allocating unbounded and
  // stalling the single Bun event loop.
  return readGzipTarEntryText(archive, "pubspec.yaml", { maxTarBytes: MAX_PUB_TAR_BYTES });
}
