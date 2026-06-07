import { buildOpamFile } from "./opam-file";
import type { OpamVersionMeta } from "./opam-validation";

/**
 * opam index generation. `GET /index.tar.gz` serves a gzipped tar of the whole
 * repository: a `repo` file at the root plus one
 * `packages/<pkg>/<pkg>.<version>/opam` file per live version. opam clients fetch
 * this once and read package metadata locally, so the bytes are regenerated from
 * the live version set on every request (small, deterministic, cacheable by ETag).
 */

const BLOCK = 512;

/** A single file to embed in the tar. */
export interface TarEntry {
  path: string;
  data: Uint8Array;
}

function octal(value: number, width: number): string {
  // ustar numeric fields are zero-padded octal with a trailing NUL.
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/**
 * Split a path into the ustar `prefix` (≤155) and `name` (≤100) fields, which
 * together encode paths up to ~255 bytes. Splits on a `/` boundary so the two
 * halves rejoin as `<prefix>/<name>`. Throws if the path cannot fit either field
 * (caller validation bounds names/versions, but a pathological combination is
 * rejected loudly rather than silently truncated into a corrupt entry).
 */
export function ustarPathFields(path: string): { name: string; prefix: string } {
  const split = splitUstarPath(path);
  if (!split) throw new Error(`opam index path too long for ustar header: ${path}`);
  return split;
}

function splitUstarPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  // Find the latest `/` such that the suffix fits in `name` (≤100) and the
  // prefix fits in `prefix` (≤155). Prefer the longest suffix that still fits.
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

/** Whether `path` fits the ustar `name`/`prefix` header fields. */
export function canEncodeUstarPath(path: string): boolean {
  return splitUstarPath(path) !== null;
}

/** Write one ustar file header + padded data block sequence. */
function tarBlocks(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  const writeField = (offset: number, max: number, text: string): void => {
    const bytes = encoder.encode(text);
    header.set(bytes.subarray(0, max), offset);
  };

  // ustar splits long paths across `name` (≤100) and `prefix` (≤155); the
  // long-name PAX extension is not needed for opam's short metadata paths.
  const { name, prefix } = ustarPathFields(entry.path);
  writeField(0, 100, name); // name
  writeField(100, 8, octal(0o644, 8)); // mode
  writeField(108, 8, octal(0, 8)); // uid
  writeField(116, 8, octal(0, 8)); // gid
  writeField(124, 12, octal(entry.data.byteLength, 12)); // size
  writeField(136, 12, octal(0, 12)); // mtime (fixed for deterministic output)
  writeField(156, 1, "0"); // typeflag: regular file
  writeField(257, 6, "ustar\0"); // magic
  writeField(263, 2, "00"); // version
  writeField(345, 155, prefix); // prefix (joined to name as `<prefix>/<name>`)

  // Checksum: computed with the checksum field treated as 8 spaces, then written
  // as 6-digit octal + NUL + space.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = `${sum.toString(8).padStart(6, "0")}\0 `;
  writeField(148, 8, checksum);

  const padded = Math.ceil(entry.data.byteLength / BLOCK) * BLOCK;
  const out = new Uint8Array(BLOCK + padded);
  out.set(header, 0);
  out.set(entry.data, BLOCK);
  return out;
}

/** Build an uncompressed ustar archive from the given entries (sorted by path). */
export function buildTar(entries: TarEntry[]): Uint8Array<ArrayBuffer> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks = sorted.map(tarBlocks);
  const total = blocks.reduce((acc, block) => acc + block.byteLength, 0);
  // Two zero blocks terminate the archive.
  const out = new Uint8Array(total + BLOCK * 2);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

/** The `repo` file served at the index root. */
export function buildRepoFile(): string {
  return 'opam-version: "2.0"\n';
}

/**
 * Build the entries for an opam repository index: the root `repo` file plus an
 * `opam` file per live version, with each `url.src` pointing at this repo's
 * archive route.
 */
export function buildOpamIndexEntries(
  versions: OpamVersionMeta[],
  srcUrlFor: (meta: OpamVersionMeta) => string,
): TarEntry[] {
  const encoder = new TextEncoder();
  const entries: TarEntry[] = [{ path: "repo", data: encoder.encode(buildRepoFile()) }];
  for (const meta of versions) {
    const path = `packages/${meta.name}/${meta.name}.${meta.version}/opam`;
    // Skip the (pathological, realistically-unreachable) case of a name+version
    // whose path overflows the ustar header so one entry can't 500 the index.
    if (!canEncodeUstarPath(path)) continue;
    entries.push({ path, data: encoder.encode(buildOpamFile(meta, srcUrlFor(meta))) });
  }
  return entries;
}

/** Build the gzipped index tarball for an opam repository. */
export function buildOpamIndexTarball(
  versions: OpamVersionMeta[],
  srcUrlFor: (meta: OpamVersionMeta) => string,
): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(buildTar(buildOpamIndexEntries(versions, srcUrlFor)));
}
