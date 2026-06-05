import { gunzipSync } from "node:zlib";

/**
 * Parse a `.deb` (a GNU `ar` archive of `debian-binary`, `control.tar.*`,
 * `data.tar.*`). We extract the `control` stanza from `control.tar.gz` and
 * compute whole-file md5/sha256/size for the Packages index. Clients send only
 * the `.deb`, so the control metadata must be recovered here.
 *
 * v1 supports gzip (or uncompressed) `control.tar`; xz/zstd are reported as
 * unsupported (Bun/node:zlib expose only gzip/deflate/brotli).
 */

const AR_MAGIC = "!<arch>\n";
const MAX_CONTROL_TAR_BYTES = 8 * 1024 * 1024;

export interface DebInfo {
  controlText: string;
  md5: string;
  sha256: string;
  size: number;
}

export type DebParseResult =
  | { ok: true; info: DebInfo }
  | { ok: false; reason: "malformed" | "unsupported_compression" };

function readTarFile(tar: Uint8Array, wanted: string[]): Uint8Array | null {
  let offset = 0;
  let scanned = 0;
  while (offset + 512 <= tar.length && scanned < 256) {
    const header = tar.subarray(offset, offset + 512);
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1;
    const name = new TextDecoder().decode(header.subarray(0, nameEnd));
    if (name === "") break;
    let sizeStr = "";
    for (let i = 124; i < 136; i += 1) {
      const code = header[i];
      if (code === undefined || code === 0 || code === 0x20) continue;
      sizeStr += String.fromCharCode(code);
    }
    const size = sizeStr ? Number.parseInt(sizeStr, 8) : 0;
    const dataStart = offset + 512;
    if (!Number.isFinite(size) || size < 0 || dataStart + size > tar.length) break;
    if (wanted.includes(name)) return tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    scanned += 1;
  }
  return null;
}

type ExtractControlResult =
  | { ok: true; text: string }
  | { ok: false; reason: "malformed" | "unsupported_compression" };

function extractControl(name: string, data: Uint8Array): ExtractControlResult {
  let tar: Uint8Array;
  if (name === "control.tar.gz") {
    try {
      tar = gunzipSync(data, { maxOutputLength: MAX_CONTROL_TAR_BYTES });
    } catch {
      return { ok: false, reason: "malformed" };
    }
  } else if (name === "control.tar") {
    tar = data;
  } else {
    return { ok: false, reason: "unsupported_compression" };
  }
  const control = readTarFile(tar, ["control", "./control"]);
  if (!control) return { ok: false, reason: "malformed" };
  return { ok: true, text: new TextDecoder().decode(control) };
}

export function parseDeb(bytes: Uint8Array): DebParseResult {
  if (bytes.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 8)) !== AR_MAGIC) {
    return { ok: false, reason: "malformed" };
  }
  let offset = 8;
  let controlText: string | null = null;
  while (offset + 60 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 60);
    const name = new TextDecoder().decode(header.subarray(0, 16)).trim().replace(/\/$/, "");
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(48, 58)).trim(), 10);
    if (!Number.isFinite(size) || size < 0) return { ok: false, reason: "malformed" };
    const dataStart = offset + 60;
    if (dataStart + size > bytes.byteLength) return { ok: false, reason: "malformed" };
    if (name.startsWith("control.tar")) {
      const result = extractControl(name, bytes.subarray(dataStart, dataStart + size));
      if (!result.ok && result.reason === "unsupported_compression") {
        return { ok: false, reason: "unsupported_compression" };
      }
      if (result.ok) controlText = result.text;
    }
    offset = dataStart + size + (size % 2);
  }
  if (controlText === null) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    info: {
      controlText: controlText.replace(/\s+$/, ""),
      md5: new Bun.CryptoHasher("md5").update(bytes).digest("hex"),
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    },
  };
}
