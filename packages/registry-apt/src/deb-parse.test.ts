import { describe, expect, test } from "bun:test";
import { parseDeb } from "./deb-parse";

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function tarEntry(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode(`${data.byteLength.toString(8).padStart(11, "0")}\0`), 124);
  header[156] = 0x30;
  const padded = Math.ceil(data.byteLength / 512) * 512;
  const body = new Uint8Array(padded);
  body.set(data, 0);
  return concat([header, body]);
}

function makeTar(entries: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  return concat([...entries.map((e) => tarEntry(e.name, e.data)), new Uint8Array(1024)]);
}

function arHeader(name: string, size: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(60).fill(0x20);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode(String(size)), 48);
  header[58] = 0x60;
  header[59] = 0x0a;
  return header;
}

function makeAr(members: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [new TextEncoder().encode("!<arch>\n")];
  for (const member of members) {
    parts.push(arHeader(member.name, member.data.byteLength), member.data);
    if (member.data.byteLength % 2 === 1) parts.push(new Uint8Array([0x0a]));
  }
  return concat(parts);
}

/** Build a `.deb` whose control.tar uses gzip (default) or names an unsupported codec. */
export function makeDeb(
  controlText: string,
  compression: "gz" | "xz" = "gz",
): Uint8Array<ArrayBuffer> {
  const controlTar = makeTar([{ name: "control", data: new TextEncoder().encode(controlText) }]);
  const controlMember =
    compression === "gz"
      ? { name: "control.tar.gz", data: Bun.gzipSync(controlTar) }
      : { name: "control.tar.xz", data: controlTar };
  const dataTar = makeTar([
    { name: "./usr/share/doc/x/README", data: new TextEncoder().encode("x") },
  ]);
  return makeAr([
    { name: "debian-binary", data: new TextEncoder().encode("2.0\n") },
    controlMember,
    { name: "data.tar.gz", data: Bun.gzipSync(dataTar) },
  ]);
}

const CONTROL = `Package: hootpkg
Version: 1.0.0
Architecture: amd64
Maintainer: e2e <e2e@hooti.test>
Description: test package`;

describe("parseDeb", () => {
  test("extracts the control stanza and whole-file digests", () => {
    const deb = makeDeb(CONTROL);
    const result = parseDeb(deb);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.controlText).toContain("Package: hootpkg");
    expect(result.info.size).toBe(deb.byteLength);
    expect(result.info.md5).toMatch(/^[a-f0-9]{32}$/);
    expect(result.info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.info.sha256).toBe(new Bun.CryptoHasher("sha256").update(deb).digest("hex"));
  });

  test("reports xz/zstd control compression as unsupported", () => {
    const result = parseDeb(makeDeb(CONTROL, "xz"));
    expect(result).toEqual({ ok: false, reason: "unsupported_compression" });
  });

  test("rejects a non-ar buffer", () => {
    expect(parseDeb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
