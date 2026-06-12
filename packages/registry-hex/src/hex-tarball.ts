import { readTarEntry } from "@hootifactory/registry";

export { readTarEntry };

/**
 * Minimal reader for a Hex release tarball. A `.tar` produced by `hex_tarball` is
 * an *uncompressed* USTAR tar whose members are:
 *   - `VERSION`        — the tarball format version (e.g. `3`)
 *   - `CHECKSUM`       — the uppercase-hex inner checksum (sha256 over the inner
 *                        members) Hex clients verify the contents against
 *   - `metadata.config`— the release metadata as an Erlang term config
 *   - `contents.tar.gz`— the gzipped tar of the actual package files
 *
 * We only need `CHECKSUM` and `metadata.config`, so the reader walks 512-byte tar
 * headers and returns the named members. No external tar dependency — and the
 * outer tar is not gzipped, so no decompression step (and thus no zip-bomb risk)
 * is needed to read the metadata.
 */

export interface HexTarballParts {
  /** The raw `metadata.config` text (an Erlang term config). */
  metadataConfig: string;
  /** The inner checksum recorded in `CHECKSUM` (lowercased hex), if present. */
  innerChecksum: string | null;
}

/** Extract the `metadata.config` text and `CHECKSUM` from a Hex release tarball. */
export function readHexTarball(tarball: Uint8Array): HexTarballParts | null {
  const metadata = readTarEntry(tarball, "metadata.config");
  if (!metadata) return null;
  const checksum = readTarEntry(tarball, "CHECKSUM");
  const innerChecksum = checksum ? new TextDecoder().decode(checksum).trim().toLowerCase() : null;
  return {
    metadataConfig: new TextDecoder().decode(metadata),
    innerChecksum: innerChecksum && /^[a-f0-9]{64}$/.test(innerChecksum) ? innerChecksum : null,
  };
}
