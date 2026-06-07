import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  type ApkIndexEntry,
  buildApkIndexTarGz,
  buildApkIndexText,
  buildIndexStanza,
} from "./apkindex";

function entry(overrides: Partial<ApkIndexEntry> = {}): ApkIndexEntry {
  return {
    name: "hello",
    version: "1.2.3-r0",
    arch: "x86_64",
    checksum: "Q1abc=",
    size: 4096,
    installedSize: null,
    description: "a demo",
    depends: ["libc", "musl"],
    provides: [],
    ...overrides,
  };
}

/** Read the single `APKINDEX` file out of an `APKINDEX.tar.gz`. */
function readApkIndex(tarGz: Uint8Array): string {
  const tar = gunzipSync(tarGz);
  // First 512 bytes are the ustar header for `APKINDEX`.
  const name = new TextDecoder().decode(tar.subarray(0, 8));
  expect(name).toBe("APKINDEX");
  let sizeStr = "";
  for (let i = 124; i < 135; i += 1) {
    const c = tar[i];
    if (c === 0 || c === 0x20) continue;
    sizeStr += String.fromCharCode(c ?? 0);
  }
  const size = Number.parseInt(sizeStr, 8);
  return new TextDecoder().decode(tar.subarray(512, 512 + size));
}

describe("APKINDEX", () => {
  test("a stanza uses the C/P/V/A/S/I/T/D/p single-letter fields", () => {
    expect(buildIndexStanza(entry({ installedSize: 81920, provides: ["so:libhello.so.1"] }))).toBe(
      "C:Q1abc=\nP:hello\nV:1.2.3-r0\nA:x86_64\nS:4096\nI:81920\nT:a demo\nD:libc musl\np:so:libhello.so.1\n",
    );
  });

  test("omits I, T, D, and p when absent", () => {
    expect(
      buildIndexStanza(
        entry({ installedSize: null, description: null, depends: [], provides: [] }),
      ),
    ).toBe("C:Q1abc=\nP:hello\nV:1.2.3-r0\nA:x86_64\nS:4096\n");
  });

  test("emits a verbatim conflict marker in D: (does not turn it into a dependency)", () => {
    const text = buildIndexStanza(entry({ depends: ["!conflicts", "libc>=1.2"] }));
    expect(text).toContain("D:!conflicts libc>=1.2\n");
  });

  test("stanzas are deterministically ordered and each ends with a blank line", () => {
    const text = buildApkIndexText([
      entry({ name: "zlib", version: "1.0-r0" }),
      entry({ name: "acl", version: "2.0-r0" }),
    ]);
    // acl sorts before zlib; a blank line separates the two stanzas.
    expect(text.indexOf("P:acl")).toBeLessThan(text.indexOf("P:zlib"));
    expect(text).toContain("\n\n");
    // apk-tools terminates every record — including the last — with a blank line.
    expect(text.endsWith("\n\n")).toBe(true);
  });

  test("packs the index into a tar.gz that round-trips back to the text", () => {
    const entries = [entry()];
    const tarGz = buildApkIndexTarGz(entries);
    expect(readApkIndex(tarGz)).toBe(buildApkIndexText(entries));
  });
});
