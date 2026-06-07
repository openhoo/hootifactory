import { describe, expect, test } from "bun:test";
import { extractCranDescription } from "./cran-tarball";

/** Build a single USTAR file entry (512 header + padded data) for `name`. */
export function tarEntry(name: string, body: string): Uint8Array<ArrayBuffer> {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(`${data.length.toString(8).padStart(11, "0")}\0`), 124);
  header.set(enc.encode("00000000000\0"), 136);
  header[156] = 0x30; // typeflag '0' (regular file)
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);

  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concat(header, padded);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Gzip a source package containing `<pkg>/DESCRIPTION` (+ optional extra members). */
export function buildCranTarball(
  pkg: string,
  description: string,
  extra: Array<{ name: string; body: string }> = [],
): Uint8Array<ArrayBuffer> {
  const entries = [
    tarEntry(`${pkg}/DESCRIPTION`, description),
    ...extra.map((e) => tarEntry(e.name, e.body)),
  ];
  return Bun.gzipSync(concat(...entries, new Uint8Array(1024)));
}

const DESCRIPTION = "Package: demo\nVersion: 1.2.3\nTitle: A Demo Package\n";

describe("CRAN tarball reader", () => {
  test("extracts a top-level DESCRIPTION from a gzipped source package", () => {
    const archive = buildCranTarball("demo", DESCRIPTION, [
      { name: "demo/R/demo.R", body: "f <- function() 1\n" },
    ]);
    expect(extractCranDescription(archive)).toBe(DESCRIPTION);
  });

  test("ignores a nested (non-top-level) DESCRIPTION", () => {
    // Only `inst/.../DESCRIPTION` is present (3 segments) — must not be matched.
    const archive = Bun.gzipSync(
      concat(tarEntry("demo/inst/extdata/DESCRIPTION", "Package: bogus\n"), new Uint8Array(1024)),
    );
    expect(extractCranDescription(archive)).toBeNull();
  });

  test("returns null for non-gzip input", () => {
    expect(extractCranDescription(new TextEncoder().encode("not a gzip"))).toBeNull();
  });

  test("rejects a decompression bomb instead of allocating unbounded", () => {
    const bomb = Bun.gzipSync(new Uint8Array(32 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(extractCranDescription(bomb)).toBeNull();
  });
});
