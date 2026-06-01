import { inflateRawSync } from "node:zlib";

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

export function validateGoModuleZip(
  bytes: Uint8Array,
  moduleName: string,
  version: string,
): string | null {
  if (bytes.byteLength < 22) return "zip payload is too short";
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
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > bytes.byteLength || readU32(view, pos) !== 0x02014b50) {
      return "zip central directory entry is invalid";
    }
    const nameLen = readU16(view, pos + 28);
    const extraLen = readU16(view, pos + 30);
    const commentLen = readU16(view, pos + 32);
    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.byteLength) return "zip filename is truncated";
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    if (hasUnsafeZipPath(name)) return "zip contains an unsafe path";
    if (!name.startsWith(prefix)) return "zip entries must be rooted at module@version";
    if (name === `${prefix}go.mod`) hasGoMod = true;
    pos = nameEnd + extraLen + commentLen;
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
    if (pos + 46 > bytes.byteLength || readU32(view, pos) !== 0x02014b50) return null;
    const method = readU16(view, pos + 10);
    const compressedSize = readU32(view, pos + 20);
    const nameLen = readU16(view, pos + 28);
    const extraLen = readU16(view, pos + 30);
    const commentLen = readU16(view, pos + 32);
    const localOffset = readU32(view, pos + 42);
    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.byteLength) return null;
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    if (name === entryName) {
      if (localOffset + 30 > bytes.byteLength || readU32(view, localOffset) !== 0x04034b50) {
        return null;
      }
      const localNameLen = readU16(view, localOffset + 26);
      const localExtraLen = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.byteLength) return null;
      const data = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return decoder.decode(data);
      if (method === 8) {
        try {
          return decoder.decode(inflateRawSync(data));
        } catch {
          return null;
        }
      }
      return null;
    }
    pos = nameEnd + extraLen + commentLen;
  }
  return null;
}
