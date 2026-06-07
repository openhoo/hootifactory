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
  test("extracts a top-level DESCRIPTION + its root directory from a gzipped package", async () => {
    const archive = buildCranTarball("demo", DESCRIPTION, [
      { name: "demo/R/demo.R", body: "f <- function() 1\n" },
    ]);
    expect(await extractCranDescription(archive)).toEqual({ top: "demo", text: DESCRIPTION });
  });

  test("reports the actual top directory even when it differs from the package name", async () => {
    // A misnamed root (`other/DESCRIPTION`) is still read, but the caller can now
    // see `top` disagrees with `Package:` and reject the publish.
    const archive = buildCranTarball("other", DESCRIPTION);
    expect(await extractCranDescription(archive)).toEqual({ top: "other", text: DESCRIPTION });
  });

  test("ignores a nested (non-top-level) DESCRIPTION", async () => {
    // Only `inst/.../DESCRIPTION` is present (3 segments) — must not be matched.
    const archive = Bun.gzipSync(
      concat(tarEntry("demo/inst/extdata/DESCRIPTION", "Package: bogus\n"), new Uint8Array(1024)),
    );
    expect(await extractCranDescription(archive)).toBeNull();
  });

  test("returns null for non-gzip input", async () => {
    expect(await extractCranDescription(new TextEncoder().encode("not a gzip"))).toBeNull();
  });

  test("reads a DESCRIPTION that precedes a data member larger than the prefix cap", async () => {
    // A legitimate large source package: DESCRIPTION first, then a 20 MiB data
    // member. Because decompression streams and stops once DESCRIPTION is read, the
    // 20 MiB tail is never materialized and the publish path is NOT blocked — the
    // old whole-tar 16 MiB cap would have thrown and rejected this real package.
    const big = "B".repeat(20 * 1024 * 1024);
    const archive = buildCranTarball("demo", DESCRIPTION, [
      { name: "demo/data/big.bin", body: big },
    ]);
    expect(await extractCranDescription(archive)).toEqual({ top: "demo", text: DESCRIPTION });
  });

  test("rejects a decompression bomb instead of allocating unbounded", async () => {
    // 32 MiB of zeros gzips tiny and carries no DESCRIPTION, so the stream is
    // aborted once the consumed prefix crosses the cap rather than expanding fully.
    const bomb = Bun.gzipSync(new Uint8Array(32 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(await extractCranDescription(bomb)).toBeNull();
  });
});
