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

const TAR_BLOCK = 512;
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

/** Find the bytes of a member by path inside a (non-gzipped) tar buffer. */
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
