import { gzipSync } from "node:zlib";

/**
 * Test-only helpers to assemble a minimal Alpine `.apk` (concatenated gzip tar
 * segments) so adapter/parse tests can exercise real package bytes.
 */

/** Concatenate byte chunks without spreading large typed arrays (which is O(n) slow). */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** A single ustar 512-byte header + padded file body. */
export function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(octalField(data.length, 12)), 124);
  header.set(enc.encode(octalField(0, 12)), 136);
  header[156] = 0x30;
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  const padded = Math.ceil(data.length / 512) * 512;
  const body = new Uint8Array(padded);
  body.set(data, 0);
  return concatBytes([header, body]);
}

function tarArchive(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts = files.map((f) => tarEntry(f.name, f.data));
  parts.push(new Uint8Array(1024)); // end-of-archive trailer
  return concatBytes(parts);
}

export interface ApkFixtureInput {
  name: string;
  version: string;
  arch: string;
  description?: string;
  depends?: string[];
  size?: number;
  extraFields?: Record<string, string>;
  /** Payload bytes for the data segment, to exercise large-package handling. */
  dataPayload?: Uint8Array;
}

export interface ApkFixtureParts {
  apk: Uint8Array;
  /** The control gzip member (`apk`'s `C:` checksum is computed over these bytes). */
  control: Uint8Array;
}

/** Build a `.apk` and return its bytes plus the control gzip segment. */
export function buildApkFixtureParts(input: ApkFixtureInput): ApkFixtureParts {
  const enc = new TextEncoder();
  const lines = [`pkgname = ${input.name}`, `pkgver = ${input.version}`, `arch = ${input.arch}`];
  if (input.description !== undefined) lines.push(`pkgdesc = ${input.description}`);
  if (input.size !== undefined) lines.push(`size = ${input.size}`);
  for (const dep of input.depends ?? []) lines.push(`depend = ${dep}`);
  for (const [k, v] of Object.entries(input.extraFields ?? {})) lines.push(`${k} = ${v}`);
  const pkginfo = `${lines.join("\n")}\n`;

  const sig = gzipSync(tarArchive([{ name: ".SIGN.RSA.dev.rsa.pub", data: enc.encode("sig") }]));
  const control = gzipSync(tarArchive([{ name: ".PKGINFO", data: enc.encode(pkginfo) }]));
  const data = gzipSync(
    tarArchive([{ name: "usr/bin/demo", data: input.dataPayload ?? enc.encode("ELF") }]),
  );
  return { apk: concatBytes([sig, control, data]), control: new Uint8Array(control) };
}

/** Build a `.apk`: signature gzip member + control (`.PKGINFO`) member + data member. */
export function buildApkFixture(input: ApkFixtureInput): Uint8Array {
  return buildApkFixtureParts(input).apk;
}
