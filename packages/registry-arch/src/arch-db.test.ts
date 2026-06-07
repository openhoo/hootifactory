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

  test("db tar contains a <pkgname>-<pkgver>/desc entry per package", () => {
    const tar = buildDbTar([entry()]);
    const files = tarFiles(tar);
    expect(files.has("foo-1.2.3-1/desc")).toBe(true);
    expect(files.get("foo-1.2.3-1/desc")).toContain("%FILENAME%");
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
