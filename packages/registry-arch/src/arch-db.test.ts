import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { type ArchDbEntry, buildArchDb, buildDbTar, buildDescFile } from "./arch-db";

function entry(overrides: Partial<ArchDbEntry> = {}): ArchDbEntry {
  return {
    blobDigest: `sha256:${"a".repeat(64)}`,
    sha256: "a".repeat(64),
    filename: "foo-1.2.3-1-x86_64.pkg.tar.zst",
    pkgname: "foo",
    pkgver: "1.2.3-1",
    arch: "x86_64",
    csize: 4096,
    depends: ["bar", "baz>=1.0"],
    pkgdesc: "demo package",
    ...overrides,
  };
}

/** Walk an uncompressed tar, returning a map of entry name -> text body. */
function tarFiles(tar: Uint8Array): Map<string, string> {
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1;
    const name = decoder.decode(header.subarray(0, nameEnd));
    if (name === "") break;
    let sizeStr = "";
    for (let i = 124; i < 136; i += 1) {
      const code = header[i];
      if (code === undefined || code === 0 || code === 0x20) continue;
      sizeStr += String.fromCharCode(code);
    }
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
    const dataStart = offset + 512;
    if (size > 0) files.set(name, decoder.decode(tar.subarray(dataStart, dataStart + size)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Like tarFiles, but reconstructs full paths from the ustar `prefix` + `name`. */
function ustarFiles(tar: Uint8Array): Map<string, string> {
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  const field = (header: Uint8Array, at: number, len: number) => {
    let end = 0;
    while (end < len && header[at + end] !== 0) end += 1;
    return decoder.decode(header.subarray(at, at + end));
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    if (name === "") break;
    const prefix = field(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    let sizeStr = "";
    for (let i = 124; i < 136; i += 1) {
      const code = header[i];
      if (code === undefined || code === 0 || code === 0x20) continue;
      sizeStr += String.fromCharCode(code);
    }
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
    const dataStart = offset + 512;
    if (size > 0) files.set(fullName, decoder.decode(tar.subarray(dataStart, dataStart + size)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe("arch db", () => {
  test("desc file renders the expected %KEY% sections", () => {
    const desc = buildDescFile(entry());
    expect(desc).toContain("%FILENAME%\nfoo-1.2.3-1-x86_64.pkg.tar.zst\n");
    expect(desc).toContain("%NAME%\nfoo\n");
    expect(desc).toContain("%VERSION%\n1.2.3-1\n");
    expect(desc).toContain("%DESC%\ndemo package\n");
    expect(desc).toContain("%CSIZE%\n4096\n");
    expect(desc).toContain(`%SHA256SUM%\n${"a".repeat(64)}\n`);
    expect(desc).toContain("%DEPENDS%\nbar\nbaz>=1.0\n");
  });

  test("desc omits empty depends and absent description", () => {
    const desc = buildDescFile(entry({ depends: [], pkgdesc: undefined }));
    expect(desc).not.toContain("%DEPENDS%");
    expect(desc).not.toContain("%DESC%");
  });

  test("desc emits %BASE% and the relation sections when present", () => {
    const desc = buildDescFile(
      entry({
        pkgbase: "foo-suite",
        provides: ["libfoo.so=1-64"],
        conflicts: ["oldfoo"],
        replaces: ["ancientfoo"],
        optdepends: ["bar: extras"],
      }),
    );
    expect(desc).toContain("%BASE%\nfoo-suite\n");
    expect(desc).toContain("%PROVIDES%\nlibfoo.so=1-64\n");
    expect(desc).toContain("%CONFLICTS%\noldfoo\n");
    expect(desc).toContain("%REPLACES%\nancientfoo\n");
    expect(desc).toContain("%OPTDEPENDS%\nbar: extras\n");
  });

  test("desc omits %BASE% and relation sections when absent/empty", () => {
    const desc = buildDescFile(entry({ pkgbase: undefined }));
    expect(desc).not.toContain("%BASE%");
    expect(desc).not.toContain("%PROVIDES%");
    expect(desc).not.toContain("%CONFLICTS%");
    expect(desc).not.toContain("%REPLACES%");
    expect(desc).not.toContain("%OPTDEPENDS%");
  });

  test("db tar contains a <pkgname>-<pkgver>/desc entry per package", () => {
    const tar = buildDbTar([entry()]);
    const files = tarFiles(tar);
    expect(files.has("foo-1.2.3-1/desc")).toBe(true);
    expect(files.get("foo-1.2.3-1/desc")).toContain("%FILENAME%");
  });

  test("db tar emits no explicit directory entries", () => {
    const tar = buildDbTar([entry()]);
    const names = new Set(tarFiles(tar).keys());
    // Only the `<dir>/desc` file is present; the bare directory is not emitted.
    expect(names.has("foo-1.2.3-1/")).toBe(false);
  });

  test("a long <pkgname>-<pkgver>/desc path round-trips via the ustar prefix field", () => {
    // A path longer than the 100-byte ustar `name` field must be split into the
    // `prefix` field rather than truncated, and a standard reader must recover it.
    const longName = "x".repeat(120);
    const tar = buildDbTar([entry({ pkgname: longName, pkgver: "1.2.3-1" })]);
    const files = ustarFiles(tar);
    expect(files.has(`${longName}-1.2.3-1/desc`)).toBe(true);
  });

  test("buildArchDb gzips to a tar and is deterministic", () => {
    const a = buildArchDb([entry(), entry({ pkgname: "alpha", pkgver: "9.9.9-1" })]);
    const b = buildArchDb([entry({ pkgname: "alpha", pkgver: "9.9.9-1" }), entry()]);
    // Sorting makes the bytes order-independent for identical input sets.
    expect(Buffer.from(a.gz).equals(Buffer.from(b.gz))).toBe(true);
    // The gz inflates back to the exact tar bytes.
    const inflated = gunzipSync(a.gz);
    expect(Buffer.from(inflated).equals(Buffer.from(a.tar))).toBe(true);
    const files = tarFiles(a.tar);
    expect(files.has("alpha-9.9.9-1/desc")).toBe(true);
    expect(files.has("foo-1.2.3-1/desc")).toBe(true);
  });
});
