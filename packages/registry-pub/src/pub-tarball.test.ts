import { describe, expect, test } from "bun:test";
import { extractPubspecYaml, readTarEntry } from "./pub-tarball";

/** Build a single USTAR file entry (512 header + padded data) for `name`. */
function tarEntry(name: string, body: string): Uint8Array<ArrayBuffer> {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  // mode/uid/gid
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  // size (octal, 11 digits + NUL)
  header.set(enc.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
  // mtime
  header.set(enc.encode("00000000000\0"), 136);
  header[156] = 0x30; // typeflag '0' (regular file)
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  // checksum: blanks during computation, then octal sum.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);

  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat(header, padded);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PUBSPEC = "name: demo\nversion: 1.2.3\n";

describe("Pub tarball reader", () => {
  test("finds a named member among other entries", () => {
    const tar = concat(
      tarEntry("README.md", "hello\n"),
      tarEntry("pubspec.yaml", PUBSPEC),
      new Uint8Array(1024), // two zero blocks (end marker)
    );
    const entry = readTarEntry(tar, "pubspec.yaml");
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry as Uint8Array)).toBe(PUBSPEC);
    expect(readTarEntry(tar, "missing.txt")).toBeNull();
  });

  test("gunzips an archive and extracts pubspec.yaml text", () => {
    const tar = concat(tarEntry("pubspec.yaml", PUBSPEC), new Uint8Array(1024));
    const archive = Bun.gzipSync(tar);
    expect(extractPubspecYaml(archive)).toBe(PUBSPEC);
  });

  test("returns null for non-gzip input", () => {
    expect(extractPubspecYaml(new TextEncoder().encode("not a gzip"))).toBeNull();
  });

  test("rejects a decompression bomb instead of allocating unbounded", () => {
    // A small gzip of 16 MiB of zeros: compresses to a few KB but expands past the
    // 8 MiB output cap. Must return null, never materialize the inflated bytes.
    const bomb = Bun.gzipSync(new Uint8Array(16 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(extractPubspecYaml(bomb)).toBeNull();
  });
});

export { concat, tarEntry };
