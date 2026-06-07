import { describe, expect, test } from "bun:test";
import { readHexTarball, readTarEntry } from "./hex-tarball";

const TAR_BLOCK = 512;
const enc = (s: string) => new TextEncoder().encode(s);

/** Build a single USTAR member (header block + NUL-padded data). */
function tarMember(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK);
  header.set(enc(name).subarray(0, 100), 0);
  // mode/uid/gid (octal, NUL-terminated) — not load-bearing for the reader.
  header.set(enc("0000644\0"), 100);
  header.set(enc("0000000\0"), 108);
  header.set(enc("0000000\0"), 116);
  // size (12-byte octal, NUL-terminated).
  header.set(enc(data.length.toString(8).padStart(11, "0") + "\0"), 124);
  // mtime.
  header.set(enc("00000000000\0"), 136);
  // type flag '0' (regular file).
  header[156] = 0x30;
  // ustar magic + version.
  header.set(enc("ustar\0"), 257);
  header.set(enc("00"), 263);
  // checksum: spaces while computing, then octal sum.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const b of header) sum += b;
  header.set(enc(sum.toString(8).padStart(6, "0") + "\0 "), 148);

  const padded = Math.ceil(data.length / TAR_BLOCK) * TAR_BLOCK;
  const body = new Uint8Array(padded);
  body.set(data);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

/** Build a Hex-shaped outer tar from named members (terminated by two zero blocks). */
export function buildHexTarball(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks = members.map((m) => tarMember(m.name, m.data));
  const trailer = new Uint8Array(TAR_BLOCK * 2);
  const total = chunks.reduce((sum, c) => sum + c.length, 0) + trailer.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  out.set(trailer, offset);
  return out;
}

const METADATA_CONFIG = [
  '{<<"name">>,<<"demo">>}.',
  '{<<"app">>,<<"demo">>}.',
  '{<<"version">>,<<"1.2.3">>}.',
  '{<<"description">>,<<"a demo package">>}.',
  '{<<"licenses">>,[<<"MIT">>]}.',
  '{<<"build_tools">>,[<<"mix">>]}.',
  '{<<"requirements">>,[[{<<"name">>,<<"poison">>},{<<"app">>,<<"poison">>},{<<"requirement">>,<<"~> 1.0">>},{<<"optional">>,false}]]}.',
].join("\n");

const INNER_CHECKSUM = "b".repeat(64);

export function demoHexTarball(): Uint8Array {
  return buildHexTarball([
    { name: "VERSION", data: enc("3") },
    { name: "CHECKSUM", data: enc(INNER_CHECKSUM.toUpperCase()) },
    { name: "metadata.config", data: enc(METADATA_CONFIG) },
    { name: "contents.tar.gz", data: enc("not-a-real-gzip-but-untouched-by-reader") },
  ]);
}

describe("Hex tarball reader", () => {
  test("reads a named member's bytes out of an outer tar", () => {
    const tar = demoHexTarball();
    const version = readTarEntry(tar, "VERSION");
    expect(version).not.toBeNull();
    expect(new TextDecoder().decode(version ?? new Uint8Array())).toBe("3");
  });

  test("returns null for a member that is not present", () => {
    expect(readTarEntry(demoHexTarball(), "does-not-exist")).toBeNull();
  });

  test("extracts metadata.config + lowercased CHECKSUM", () => {
    const parts = readHexTarball(demoHexTarball());
    expect(parts).not.toBeNull();
    expect(parts?.metadataConfig).toContain('{<<"name">>,<<"demo">>}.');
    expect(parts?.innerChecksum).toBe(INNER_CHECKSUM);
  });

  test("returns null when metadata.config is absent", () => {
    const tar = buildHexTarball([{ name: "VERSION", data: enc("3") }]);
    expect(readHexTarball(tar)).toBeNull();
  });

  test("tolerates a tarball with no CHECKSUM member", () => {
    const tar = buildHexTarball([
      { name: "VERSION", data: enc("3") },
      { name: "metadata.config", data: enc(METADATA_CONFIG) },
    ]);
    const parts = readHexTarball(tar);
    expect(parts).not.toBeNull();
    expect(parts?.innerChecksum).toBeNull();
  });
});
