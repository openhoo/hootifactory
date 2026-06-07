import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { buildIndexTar, buildIndexTarGz, extractCabalFromSdist } from "./hackage-tarball";

const TAR_BLOCK = 512;
const encoder = new TextEncoder();

/** Build a single USTAR file header (mirrors the writer, for test fixtures). */
function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(TAR_BLOCK);
  h.set(encoder.encode(name).subarray(0, 100), 0);
  h.set(encoder.encode("0000644\0"), 100);
  h.set(encoder.encode("0000000\0"), 108);
  h.set(encoder.encode("0000000\0"), 116);
  h.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  h.set(encoder.encode("00000000000\0"), 136);
  h[156] = 0x30;
  h.set(encoder.encode("ustar\0"), 257);
  h.set(encoder.encode("00"), 263);
  h.fill(0x20, 148, 156);
  let cs = 0;
  for (const b of h) cs += b;
  h.set(encoder.encode(`${cs.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

/**
 * Build a gzipped sdist tarball with the given members. Shared by the adapter
 * publish round-trip tests.
 */
export function buildSdistTarGz(members: { path: string; content: string }[]): Uint8Array {
  const parts: number[] = [];
  for (const member of members) {
    const data = encoder.encode(member.content);
    for (const b of tarHeader(member.path, data.length)) parts.push(b);
    for (const b of data) parts.push(b);
    const remainder = data.length % TAR_BLOCK;
    if (remainder !== 0) {
      for (let i = 0; i < TAR_BLOCK - remainder; i++) parts.push(0);
    }
  }
  for (let i = 0; i < TAR_BLOCK * 2; i++) parts.push(0);
  return Bun.gzipSync(new Uint8Array(parts));
}

describe("extractCabalFromSdist", () => {
  test("returns the top-level .cabal text from a gzipped sdist", () => {
    const gz = buildSdistTarGz([
      { path: "my-lib-1.0/my-lib.cabal", content: "name: my-lib\nversion: 1.0\n" },
      { path: "my-lib-1.0/src/Lib.hs", content: "module Lib where" },
    ]);
    expect(extractCabalFromSdist(gz)).toBe("name: my-lib\nversion: 1.0\n");
  });

  test("ignores .cabal files nested deeper than the sdist root", () => {
    const gz = buildSdistTarGz([
      { path: "my-lib-1.0/vendor/dep.cabal", content: "name: dep\nversion: 9.9\n" },
    ]);
    expect(extractCabalFromSdist(gz)).toBeNull();
  });

  test("returns null for non-gzip input", () => {
    expect(extractCabalFromSdist(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  test("returns null when the inflated sdist exceeds the tar byte cap", () => {
    // A tiny gzip that expands beyond the configured cap. The production cap is
    // 64 MiB; the smaller test cap keeps the guard fast under repo-wide CI load.
    const bomb = Bun.gzipSync(new Uint8Array(2 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(extractCabalFromSdist(bomb, { maxTarBytes: 1024 * 1024 })).toBeNull();
  });
});

describe("buildIndexTar", () => {
  test("emits block-aligned entries terminated by two zero blocks", () => {
    const tar = buildIndexTar([{ path: "foo/1.0/foo.cabal", cabal: "name: foo\n" }]);
    // 1 header + 1 data block + 2 trailing zero blocks.
    expect(tar.length).toBe(TAR_BLOCK * 4);
    expect(tar.length % TAR_BLOCK).toBe(0);
  });

  test("round-trips through gunzip and is readable by the sdist reader", () => {
    const gz = buildIndexTarGz([{ path: "foo/1.0/foo.cabal", cabal: "name: foo\nversion: 1.0\n" }]);
    const tar = gunzipSync(gz);
    expect(tar.length % TAR_BLOCK).toBe(0);
    // The first header's name field carries the index path.
    const name = new TextDecoder().decode(tar.subarray(0, 17));
    expect(name).toBe("foo/1.0/foo.cabal");
  });
});
