import { zstdCompressSync } from "node:zlib";

/** Build a single 512-byte ustar header for a regular file. */
function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  header.set(enc.encode("00000000000\0"), 136);
  header[156] = 0x30; // regular file
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Build a tar stream whose first member is a `.PKGINFO` with the given body. */
export function buildPkgInfoTar(pkginfo: string): Uint8Array {
  const enc = new TextEncoder();
  const body = enc.encode(pkginfo);
  const pad = (512 - (body.length % 512)) % 512;
  return concat([
    tarHeader(".PKGINFO", body.length),
    body,
    new Uint8Array(pad),
    new Uint8Array(1024),
  ]);
}

export interface PkgInfoFixture {
  pkgname: string;
  pkgbase?: string;
  pkgver: string;
  arch: string;
  pkgdesc?: string;
  depends?: string[];
  provides?: string[];
  conflicts?: string[];
  replaces?: string[];
  optdepends?: string[];
}

/** Build a real zstd-compressed pacman package archive carrying a `.PKGINFO`. */
export function buildArchPackage(input: PkgInfoFixture): Uint8Array {
  const lines = [`pkgname = ${input.pkgname}`, `pkgver = ${input.pkgver}`, `arch = ${input.arch}`];
  if (input.pkgbase) lines.push(`pkgbase = ${input.pkgbase}`);
  if (input.pkgdesc) lines.push(`pkgdesc = ${input.pkgdesc}`);
  for (const dep of input.depends ?? []) lines.push(`depend = ${dep}`);
  for (const dep of input.provides ?? []) lines.push(`provides = ${dep}`);
  for (const dep of input.conflicts ?? []) lines.push(`conflict = ${dep}`);
  for (const dep of input.replaces ?? []) lines.push(`replaces = ${dep}`);
  for (const dep of input.optdepends ?? []) lines.push(`optdepend = ${dep}`);
  const tar = buildPkgInfoTar(`${lines.join("\n")}\n`);
  const zst = zstdCompressSync(tar);
  return new Uint8Array(zst.buffer, zst.byteOffset, zst.byteLength);
}
