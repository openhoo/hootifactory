import { describe, expect, test } from "bun:test";
import { buildArchPackage } from "./arch-fixtures";
import { readPkgInfo } from "./pkg-parse";

describe("pkg parse", () => {
  test("reads .PKGINFO from a zstd package archive", () => {
    const pkg = buildArchPackage({
      pkgname: "foo",
      pkgver: "1.2.3-1",
      arch: "x86_64",
      pkgdesc: "demo",
      depends: ["bar", "baz>=1.0"],
    });
    const result = readPkgInfo(pkg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info).toEqual({
      pkgname: "foo",
      pkgver: "1.2.3-1",
      arch: "x86_64",
      pkgdesc: "demo",
      depends: ["bar", "baz>=1.0"],
      provides: [],
      conflicts: [],
      replaces: [],
      optdepends: [],
    });
  });

  test("reports unsupported_compression for an xz archive", () => {
    // xz magic header: FD 37 7A 58 5A 00.
    const xz = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0, 0, 0]);
    expect(readPkgInfo(xz)).toEqual({ ok: false, reason: "unsupported_compression" });
  });

  test("reports malformed for non-archive bytes", () => {
    expect(readPkgInfo(new Uint8Array([1, 2, 3, 4]))).toEqual({ ok: false, reason: "malformed" });
    expect(readPkgInfo(new Uint8Array())).toEqual({ ok: false, reason: "malformed" });
  });
});
