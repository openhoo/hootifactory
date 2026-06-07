/**
 * APKINDEX generation. An Alpine repository's `<arch>/APKINDEX.tar.gz` is a
 * gzip-compressed tar containing an `APKINDEX` file. That file holds one stanza
 * per package, fields separated by `\n` and stanzas separated by a blank line.
 * Single-letter fields are used: `C:` (checksum), `P:` (name), `V:` (version),
 * `A:` (arch), `S:` (size), `I:` (installed size), `T:` (description),
 * `D:` (dependencies), `p:` (provides). We regenerate the index from the live
 * versions on every request so it always reflects the current package set.
 */

export interface ApkIndexEntry {
  name: string;
  version: string;
  arch: string;
  /** apk `Q1...` content checksum of the package's control segment. */
  checksum: string;
  /** Compressed package size in bytes (the `.apk` blob size). */
  size: number;
  /** Uncompressed/installed size in bytes (`I:`); omitted from output when null. */
  installedSize: number | null;
  description: string | null;
  /** Raw apk dependency tokens (`D:`), kept verbatim (incl. `!conflicts`). */
  depends: string[];
  /** Raw apk provides tokens (`p:`). */
  provides: string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One APKINDEX stanza for a single package version. */
export function buildIndexStanza(entry: ApkIndexEntry): string {
  const lines = [
    `C:${entry.checksum}`,
    `P:${entry.name}`,
    `V:${entry.version}`,
    `A:${entry.arch}`,
    `S:${entry.size}`,
  ];
  if (entry.installedSize !== null) lines.push(`I:${entry.installedSize}`);
  if (entry.description) lines.push(`T:${entry.description}`);
  if (entry.depends.length > 0) lines.push(`D:${entry.depends.join(" ")}`);
  if (entry.provides.length > 0) lines.push(`p:${entry.provides.join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The full APKINDEX text: deterministically-ordered stanzas, each (including the
 * last) terminated by a blank line — apk-tools-generated indexes always end the
 * final record with a separating blank line.
 */
export function buildApkIndexText(entries: ApkIndexEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
  );
  return sorted.map((entry) => `${buildIndexStanza(entry)}\n`).join("");
}

/** Pad a ustar numeric field to `width-1` octal digits plus a trailing NUL. */
function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** Build a single ustar 512-byte header + padded file data for `name`. */
function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode("0000644\0"), 100); // mode
  header.set(enc.encode("0000000\0"), 108); // uid
  header.set(enc.encode("0000000\0"), 116); // gid
  header.set(enc.encode(octalField(data.length, 12)), 124); // size
  header.set(enc.encode(octalField(0, 12)), 136); // mtime
  header[156] = 0x30; // typeflag '0' (regular file)
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263); // version

  // Checksum: compute over the header with the checksum field as spaces.
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);

  const padded = Math.ceil(data.length / 512) * 512;
  const body = new Uint8Array(padded);
  body.set(data, 0);
  return new Uint8Array([...header, ...body]);
}

/**
 * Pack the APKINDEX text into the `APKINDEX.tar.gz` apk clients fetch. The tar
 * ends with two zero blocks per the ustar spec.
 */
export function buildApkIndexTarGz(entries: ApkIndexEntry[]): Uint8Array {
  const text = buildApkIndexText(entries);
  const file = tarEntry("APKINDEX", new TextEncoder().encode(text));
  const trailer = new Uint8Array(1024); // two zero blocks
  const tar = new Uint8Array([...file, ...trailer]);
  return Bun.gzipSync(tar);
}
