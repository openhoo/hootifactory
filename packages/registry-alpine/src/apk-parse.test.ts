import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { buildApkFixture, buildApkFixtureParts, tarEntry } from "./apk-fixture";
import { parseApk, parsePkgInfo } from "./apk-parse";

function q1(bytes: Uint8Array): string {
  return `Q1${new Bun.CryptoHasher("sha1").update(bytes).digest("base64")}`;
}

describe("parsePkgInfo", () => {
  test("extracts name/version/arch and verbatim dependency tokens", () => {
    const info = parsePkgInfo(
      "pkgname = hello\npkgver = 1.2.3-r0\narch = x86_64\nsize = 4096\n" +
        "pkgdesc = A demo\ndepend = libc\ndepend = so:libz.so.1\ndepend = foo>=2.0\n",
    );
    expect(info.name).toBe("hello");
    expect(info.version).toBe("1.2.3-r0");
    expect(info.arch).toBe("x86_64");
    expect(info.size).toBe(4096);
    expect(info.description).toBe("A demo");
    // Version constraints and namespaced provides are preserved verbatim so the
    // APKINDEX D: field can be resolved by apk.
    expect(info.depends).toEqual(["libc", "so:libz.so.1", "foo>=2.0"]);
  });

  test("ignores comments and blank lines, keeps the last repeated scalar", () => {
    const info = parsePkgInfo("# comment\n\npkgname = a\npkgname = b\narch = x86\npkgver = 1-r0\n");
    expect(info.name).toBe("b");
    expect(info.size).toBeNull();
  });

  test("preserves a leading conflict marker on a dependency (does not invert it)", () => {
    // `!name` is an apk CONFLICT; reducing it to `name` would turn a conflict into
    // a hard install dependency, so the marker must survive verbatim.
    const info = parsePkgInfo("pkgname = a\npkgver = 1-r0\narch = x86\ndepend = !conflicts\n");
    expect(info.depends).toEqual(["!conflicts"]);
  });

  test("parses provides tokens verbatim", () => {
    const info = parsePkgInfo(
      "pkgname = a\npkgver = 1-r0\narch = x86\nprovides = so:liba.so.1\nprovides = cmd:a=1-r0\n",
    );
    expect(info.provides).toEqual(["so:liba.so.1", "cmd:a=1-r0"]);
  });
});

describe("parseApk", () => {
  test("parses a real concatenated-gzip .apk and yields a Q1 checksum", () => {
    const apk = buildApkFixture({
      name: "hello",
      version: "1.2.3-r0",
      arch: "x86_64",
      description: "demo",
      depends: ["libc", "musl"],
      size: 9000,
    });
    const result = parseApk(apk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.name).toBe("hello");
    expect(result.info.version).toBe("1.2.3-r0");
    expect(result.info.arch).toBe("x86_64");
    expect(result.info.depends).toEqual(["libc", "musl"]);
    // The control-segment checksum is the apk `Q1` + base64(sha1) form.
    expect(result.checksum).toMatch(/^Q1[A-Za-z0-9+/]+=*$/);
  });

  test("the checksum is over the control segment, not the whole .apk", () => {
    const { apk, control } = buildApkFixtureParts({
      name: "hello",
      version: "1.2.3-r0",
      arch: "x86_64",
    });
    const result = parseApk(apk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checksum).toBe(q1(control));
    // Sanity: the whole-file checksum differs, so we are not falling back to it.
    expect(result.checksum).not.toBe(q1(apk));
  });

  test("parses a package whose data segment is far larger than the control segment", () => {
    // The (uncompressed) data payload dwarfs the few-hundred-byte control segment,
    // yet parsing stays cheap because we stop at the control member and never
    // inflate the data tarball. 256 KiB is comfortably "far larger" while keeping
    // the test fast and deterministic on slow CI runners — a naive whole-stream
    // inflate would have to expand the entire data member, this parser must not.
    const dataPayload = new Uint8Array(256 * 1024).fill(0x41);
    const { apk, control } = buildApkFixtureParts({
      name: "big",
      version: "1.0-r0",
      arch: "x86_64",
      dataPayload,
    });
    // The data payload alone is two orders of magnitude larger than the control.
    expect(dataPayload.length).toBeGreaterThan(control.length * 100);
    const result = parseApk(apk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.name).toBe("big");
    // The checksum is over the control member only — the large data member is
    // never inflated or hashed.
    expect(result.checksum).toBe(q1(control));
  });

  test("rejects bytes that are not gzip", () => {
    expect(parseApk(new Uint8Array([1, 2, 3, 4]))).toEqual({ ok: false, reason: "malformed" });
  });

  test("reports missing .PKGINFO when no control file is present", () => {
    // A valid gzip tar that contains only a data file — no `.PKGINFO`.
    const trailer = new Uint8Array(1024);
    const entry = tarEntry("usr/bin/demo", new TextEncoder().encode("ELF"));
    const apk = gzipSync(new Uint8Array([...entry, ...trailer]));
    expect(parseApk(apk)).toEqual({ ok: false, reason: "missing_pkginfo" });
  });
});
