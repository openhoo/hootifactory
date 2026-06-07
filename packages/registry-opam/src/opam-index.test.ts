import { describe, expect, test } from "bun:test";
import {
  buildOpamIndexEntries,
  buildOpamIndexTarball,
  buildRepoFile,
  buildTar,
  type TarEntry,
  ustarPathFields,
} from "./opam-index";
import type { OpamVersionMeta } from "./opam-validation";

const HEX = "a".repeat(64);

function meta(name: string, version: string): OpamVersionMeta {
  return {
    name,
    version,
    synopsis: `${name} synopsis`,
    blobDigest: `sha256:${HEX}`,
    sha256: HEX,
    filename: `${name}-${version}.tar.gz`,
  };
}

/** Minimal ustar reader: returns { path -> text } for the test's small archives. */
function readTar(tar: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    // A zero-filled block marks the end of the archive.
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeField, 8);
    const dataStart = offset + 512;
    out.set(path, decoder.decode(tar.subarray(dataStart, dataStart + size)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("opam index", () => {
  test("repo file declares opam-version 2.0", () => {
    expect(buildRepoFile()).toBe('opam-version: "2.0"\n');
  });

  test("buildTar produces a readable ustar archive terminated by zero blocks", () => {
    const entries: TarEntry[] = [
      { path: "repo", data: new TextEncoder().encode("hi\n") },
      { path: "packages/x/x.1.0/opam", data: new TextEncoder().encode("body\n") },
    ];
    const tar = buildTar(entries);
    // Multiple of 512 and ends with two zero blocks.
    expect(tar.byteLength % 512).toBe(0);
    const read = readTar(tar);
    expect(read.get("repo")).toBe("hi\n");
    expect(read.get("packages/x/x.1.0/opam")).toBe("body\n");
  });

  test("ustarPathFields keeps short paths in `name` and splits long paths on a slash", () => {
    expect(ustarPathFields("packages/lwt/lwt.5.6.1/opam")).toEqual({
      name: "packages/lwt/lwt.5.6.1/opam",
      prefix: "",
    });
    // A 136-byte path: too long for `name` alone (≤100), so it splits on a slash
    // boundary into `prefix` + `name` that rejoin to the original path.
    const long = `packages/${"a".repeat(40)}/${"a".repeat(40)}.${"1".repeat(40)}/opam`;
    expect(long.length).toBeGreaterThan(100);
    const { name, prefix } = ustarPathFields(long);
    expect(`${prefix}/${name}`).toBe(long);
    expect(prefix.length).toBeLessThanOrEqual(155);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  test("long opam paths round-trip through the tar without truncation", () => {
    const path = `packages/${"a".repeat(40)}/${"a".repeat(40)}.${"1".repeat(40)}/opam`;
    expect(path.length).toBeGreaterThan(100);
    const tar = buildTar([{ path, data: new TextEncoder().encode("x\n") }]);
    expect(readTar(tar).get(path)).toBe("x\n");
  });

  test("ustarPathFields throws when a path cannot fit the ustar header fields", () => {
    // A single 200-byte segment after the last slash exceeds `name` (100) and
    // cannot be split onto a `/` boundary, so it is rejected loudly.
    expect(() => ustarPathFields(`dir/${"z".repeat(200)}`)).toThrow();
  });

  test("index entries include the repo file and one opam file per version", () => {
    const entries = buildOpamIndexEntries(
      [meta("lwt", "5.6.1"), meta("dune", "3.0.0")],
      (m) => `https://reg.test/opam/o/r/archives/${m.name}/${m.version}/${m.filename}`,
    );
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("repo");
    expect(paths).toContain("packages/lwt/lwt.5.6.1/opam");
    expect(paths).toContain("packages/dune/dune.3.0.0/opam");
    const opam = new TextDecoder().decode(
      entries.find((e) => e.path === "packages/lwt/lwt.5.6.1/opam")?.data,
    );
    expect(opam).toContain('name: "lwt"');
    expect(opam).toContain('src: "https://reg.test/opam/o/r/archives/lwt/5.6.1/lwt-5.6.1.tar.gz"');
  });

  test("buildOpamIndexTarball gzips a tar whose opam files carry the computed url + checksum", () => {
    const tarball = buildOpamIndexTarball(
      [meta("lwt", "5.6.1")],
      (m) => `https://reg.test/opam/o/r/archives/${m.name}/${m.version}/${m.filename}`,
    );
    const read = readTar(Bun.gunzipSync(tarball));
    expect(read.has("repo")).toBe(true);
    const opam = read.get("packages/lwt/lwt.5.6.1/opam");
    expect(opam).toBeDefined();
    expect(opam).toContain('opam-version: "2.0"');
    expect(opam).toContain(`checksum: [ "sha256=${HEX}" ]`);
  });

  test("entries are deterministically ordered so the tarball bytes are stable", () => {
    const make = () =>
      buildOpamIndexTarball(
        [meta("zlib", "1.0"), meta("alpha", "2.0")],
        (m) => `https://reg.test/opam/o/r/archives/${m.name}/${m.version}/${m.filename}`,
      );
    expect(Array.from(make())).toEqual(Array.from(make()));
  });
});
