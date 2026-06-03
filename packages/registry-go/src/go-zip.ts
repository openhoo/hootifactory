import { inflateRawSync } from "node:zlib";

const MAX_ZIP_FILE_BYTES = 500 * 1024 * 1024;
const MAX_ZIP_CONTENT_BYTES = 500 * 1024 * 1024;
const MAX_GO_MOD_BYTES = 16 * 1024 * 1024;
const MAX_LICENSE_BYTES = 16 * 1024 * 1024;
const ZIP64_SENTINEL = 0xffffffff;

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export function decodeModuleDirective(mod: string): string | null {
  for (const line of mod.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const match = /^module\s+(\S+)\s*$/.exec(trimmed);
    return match?.[1] ?? null;
  }
  return null;
}

function findZipEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (readU32(view, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function hasUnsafeZipPath(name: string): boolean {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!path || path.startsWith("/") || path.includes("\\")) return true;
  return path.split("/").some((part) => !part || part === "." || part === "..");
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  nextPos: number;
}

function readCentralEntry(
  bytes: Uint8Array,
  view: DataView,
  pos: number,
  decoder: TextDecoder,
): ZipEntry | string {
  if (pos + 46 > bytes.byteLength || readU32(view, pos) !== 0x02014b50) {
    return "zip central directory entry is invalid";
  }
  const method = readU16(view, pos + 10);
  const compressedSize = readU32(view, pos + 20);
  const uncompressedSize = readU32(view, pos + 24);
  const nameLen = readU16(view, pos + 28);
  const extraLen = readU16(view, pos + 30);
  const commentLen = readU16(view, pos + 32);
  const localOffset = readU32(view, pos + 42);
  if (
    compressedSize === ZIP64_SENTINEL ||
    uncompressedSize === ZIP64_SENTINEL ||
    localOffset === ZIP64_SENTINEL
  ) {
    return "zip64 module zips are not supported";
  }
  const nameStart = pos + 46;
  const nameEnd = nameStart + nameLen;
  if (nameEnd > bytes.byteLength) return "zip filename is truncated";
  return {
    name: decoder.decode(bytes.subarray(nameStart, nameEnd)),
    method,
    compressedSize,
    uncompressedSize,
    localOffset,
    nextPos: nameEnd + extraLen + commentLen,
  };
}

function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  entry: ZipEntry,
  decoder: TextDecoder,
): Uint8Array | string {
  if (
    entry.localOffset + 30 > bytes.byteLength ||
    readU32(view, entry.localOffset) !== 0x04034b50
  ) {
    return "zip local file header is invalid";
  }
  const localNameLen = readU16(view, entry.localOffset + 26);
  const localExtraLen = readU16(view, entry.localOffset + 28);
  const localNameStart = entry.localOffset + 30;
  const localNameEnd = localNameStart + localNameLen;
  if (localNameEnd > bytes.byteLength) return "zip local filename is truncated";
  if (decoder.decode(bytes.subarray(localNameStart, localNameEnd)) !== entry.name) {
    return "zip local filename does not match central directory";
  }
  const dataStart = localNameEnd + localExtraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) return "zip entry data is truncated";
  return bytes.subarray(dataStart, dataEnd);
}

function inflateEntryData(data: Uint8Array, method: number): Uint8Array | string {
  if (method === 0) return data;
  if (method !== 8) return "zip entry uses an unsupported compression method";
  try {
    return inflateRawSync(data);
  } catch {
    return "zip entry cannot be inflated";
  }
}

export function validateGoModuleZip(
  bytes: Uint8Array,
  moduleName: string,
  version: string,
): string | null {
  if (bytes.byteLength < 22) return "zip payload is too short";
  if (bytes.byteLength > MAX_ZIP_FILE_BYTES) return "zip file is too large";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findZipEndOfCentralDirectory(view);
  if (eocd < 0) return "zip end of central directory not found";

  const entries = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (entries < 1) return "zip has no entries";
  if (centralOffset + centralSize > bytes.byteLength) return "zip central directory is truncated";

  const prefix = `${moduleName}@${version}/`;
  const decoder = new TextDecoder();
  let pos = centralOffset;
  let hasGoMod = false;
  let totalUncompressed = 0;
  const foldedNames = new Set<string>();
  for (let i = 0; i < entries; i++) {
    const entry = readCentralEntry(bytes, view, pos, decoder);
    if (typeof entry === "string") return entry;
    if (hasUnsafeZipPath(entry.name)) return "zip contains an unsafe path";
    if (!entry.name.startsWith(prefix)) return "zip entries must be rooted at module@version";

    const folded = entry.name.toLowerCase();
    if (foldedNames.has(folded)) return "zip contains case-insensitive path collision";
    foldedNames.add(folded);

    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_ZIP_CONTENT_BYTES) return "zip contents are too large";

    const relative = entry.name.slice(prefix.length);
    const basename = relative.split("/").at(-1) ?? "";
    if (basename.toLowerCase() === "go.mod" && entry.name !== `${prefix}go.mod`) {
      return "go.mod file not in module root directory";
    }
    if (entry.name === `${prefix}go.mod`) {
      if (entry.uncompressedSize > MAX_GO_MOD_BYTES) return "go.mod is too large";
      hasGoMod = true;
    }
    if (entry.name === `${prefix}LICENSE` && entry.uncompressedSize > MAX_LICENSE_BYTES) {
      return "LICENSE is too large";
    }

    const data = readEntryData(bytes, view, entry, decoder);
    if (typeof data === "string") return data;
    const inflated = inflateEntryData(data, entry.method);
    if (typeof inflated === "string") return inflated;
    if (inflated.byteLength !== entry.uncompressedSize) {
      return "zip entry size does not match header";
    }
    pos = entry.nextPos;
  }
  if (pos > centralOffset + centralSize) return "zip central directory exceeds declared size";
  if (!hasGoMod) return "zip is missing go.mod";
  return null;
}

export function readZipEntryText(bytes: Uint8Array, entryName: string): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findZipEndOfCentralDirectory(view);
  if (eocd < 0) return null;

  const entries = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (centralOffset + centralSize > bytes.byteLength) return null;

  const decoder = new TextDecoder();
  let pos = centralOffset;
  for (let i = 0; i < entries; i++) {
    const entry = readCentralEntry(bytes, view, pos, decoder);
    if (typeof entry === "string") return null;
    if (entry.name === entryName) {
      const data = readEntryData(bytes, view, entry, decoder);
      if (typeof data === "string") return null;
      const inflated = inflateEntryData(data, entry.method);
      if (typeof inflated === "string") return null;
      if (inflated.byteLength !== entry.uncompressedSize) return null;
      return decoder.decode(inflated);
    }
    pos = entry.nextPos;
  }
  return null;
}
