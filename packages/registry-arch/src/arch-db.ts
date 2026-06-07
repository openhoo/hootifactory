import type { ArchVersionMeta } from "./arch-validation";

/**
 * Pacman sync-database generation. A `<repo>.db` (served identically as
 * `<repo>.db.tar.gz`) is a gzip-compressed tar whose entries are
 * `<pkgname>-<pkgver>/desc` text files. Each `desc` lists the package's
 * attributes in `%KEY%`\n value\n\n stanzas. The DB is regenerated from the
 * live package versions on every request, so it always matches the served
 * blobs. The build is deterministic (sorted, fixed tar headers, no embedded
 * mtimes) so identical repo state yields byte-identical bytes and a stable ETag.
 */

export interface ArchDbEntry extends ArchVersionMeta {}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Render one `desc` file body for a package version. */
export function buildDescFile(entry: ArchDbEntry): string {
  const sections: Array<[string, string | number | string[] | undefined]> = [
    ["FILENAME", entry.filename],
    ["NAME", entry.pkgname],
    ["VERSION", entry.pkgver],
    ["DESC", entry.pkgdesc],
    ["CSIZE", entry.csize],
    ["ARCH", entry.arch],
    ["SHA256SUM", entry.sha256],
    ["DEPENDS", entry.depends.length > 0 ? entry.depends : undefined],
  ];
  let out = "";
  for (const [key, value] of sections) {
    if (value === undefined) continue;
    const lines = Array.isArray(value) ? value : [String(value)];
    if (lines.length === 0) continue;
    out += `%${key}%\n${lines.join("\n")}\n\n`;
  }
  return out;
}

/**
 * Split a path into ustar `name` (<=100 bytes) and `prefix` (<=155 bytes) parts
 * at a `/` boundary, as the ustar format requires for paths over 100 bytes.
 * Returns null when no split keeps both parts within their limits (i.e. the path
 * cannot be represented and must be rejected rather than silently truncated).
 */
function ustarPathParts(name: string): { name: string; prefix: string } | null {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= 100) return { name, prefix: "" };
  // Find the latest `/` such that the trailing component fits in `name` (<=100)
  // and the leading component fits in `prefix` (<=155).
  for (let i = name.length - 1; i > 0; i -= 1) {
    if (name[i] !== "/") continue;
    const tail = name.slice(i + 1);
    const head = name.slice(0, i);
    const tailLen = new TextEncoder().encode(tail).length;
    const headLen = new TextEncoder().encode(head).length;
    if (tailLen > 0 && tailLen <= 100 && headLen <= 155) {
      return { name: tail, prefix: head };
    }
  }
  return null;
}

/** A 512-byte ustar header for a regular file entry (`name` fits name+prefix). */
function tarHeader(name: string, size: number): Uint8Array {
  const parts = ustarPathParts(name);
  if (!parts) {
    throw new Error(`arch db: entry path too long for ustar: ${name}`);
  }
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  const write = (text: string, at: number, max: number) => {
    const bytes = enc.encode(text);
    header.set(bytes.subarray(0, max), at);
  };
  write(parts.name, 0, 100);
  write("0000644\0", 100, 8); // mode
  write("0000000\0", 108, 8); // uid
  write("0000000\0", 116, 8); // gid
  write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12); // size (octal)
  write("00000000000\0", 136, 12); // mtime — fixed at 0 for determinism
  // type flag: '0' for a regular file.
  header[156] = 0x30;
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  // ustar `prefix` field carries the leading path component for long paths.
  write(parts.prefix, 345, 155);
  // Checksum field is computed over the header with the checksum bytes as spaces.
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function padTo512(size: number): number {
  return (512 - (size % 512)) % 512;
}

/** Concatenate ustar `<pkgname>-<pkgver>/desc` file entries into a tar stream. */
export function buildDbTar(entries: ArchDbEntry[]): Uint8Array<ArrayBuffer> {
  const sorted = [...entries].sort(
    (a, b) =>
      compare(a.pkgname, b.pkgname) ||
      compare(a.pkgver, b.pkgver) ||
      compare(a.arch, b.arch) ||
      compare(a.filename, b.filename),
  );
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of sorted) {
    // No explicit directory entry: tar extractors create the parent dir from the
    // file path, and a bare `<pkgname>-<pkgver>/` name has no `/` to split on for
    // the ustar prefix field, so it can't be represented for long names anyway.
    const desc = enc.encode(buildDescFile(entry));
    chunks.push(tarHeader(`${entry.pkgname}-${entry.pkgver}/desc`, desc.length));
    chunks.push(desc);
    const pad = padTo512(desc.length);
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  // Two zero blocks terminate the archive.
  chunks.push(new Uint8Array(1024));
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const tar = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.length;
  }
  return tar;
}

export interface ArchDb {
  /** gzip(tar) — the exact bytes served at `<repo>.db` / `<repo>.db.tar.gz`. */
  gz: Uint8Array;
  /** The uncompressed tar bytes. */
  tar: Uint8Array;
}

/** Build the sync DB (gzip'd tar) for a repo's live package versions. */
export function buildArchDb(entries: ArchDbEntry[]): ArchDb {
  const tar = buildDbTar(entries);
  // Bun.gzipSync zeroes the gzip header mtime by default, so identical tar bytes
  // gzip to identical output — keeping the DB (and its ETag) deterministic.
  const gz = Bun.gzipSync(tar);
  return { gz, tar };
}
