/**
 * Minimal, dependency-free reader for the metadata in an `.rpm` package.
 *
 * Layout of an `.rpm` file:
 *   - 96-byte lead (legacy, mostly ignored; begins with magic ED AB EE DB).
 *   - the signature header.
 *   - the main (a.k.a. "header") header.
 *
 * Each header is:
 *   magic   = 8E AD E8 01          (3-byte magic + 1 version byte)
 *   reserved= 00 00 00 00          (4 bytes)
 *   nindex  = uint32 (big-endian)  number of index entries
 *   hsize   = uint32 (big-endian)  total size of the data store in bytes
 *   then `nindex` 16-byte index entries: { tag u32, type u32, offset u32, count u32 }
 *   then the data store of `hsize` bytes.
 *
 * The signature header's store is padded to an 8-byte boundary before the main
 * header begins. We skip the lead + signature header (with that alignment) and
 * read the requested tags from the main header.
 */

const HEADER_MAGIC = 0x8eade801;
const LEAD_SIZE = 96;
const HEADER_PREAMBLE_SIZE = 16;
const INDEX_ENTRY_SIZE = 16;

// Tag types (a subset; we only decode the ones the metadata tags use).
const TYPE_INT16 = 3;
const TYPE_INT32 = 4;
const TYPE_STRING = 6;
const TYPE_STRING_ARRAY = 8;
const TYPE_I18NSTRING = 9;

// Main-header tags we care about.
export const RPM_TAG_NAME = 1000;
export const RPM_TAG_VERSION = 1001;
export const RPM_TAG_RELEASE = 1002;
export const RPM_TAG_EPOCH = 1003;
export const RPM_TAG_SUMMARY = 1004;
export const RPM_TAG_ARCH = 1022;

// Defensive bounds so a malformed/huge header cannot exhaust memory.
const MAX_NINDEX = 1 << 20;
const MAX_HSIZE = 256 * 1024 * 1024;

function u32be(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) * 0x1000000 +
      ((b[o + 1] ?? 0) << 16) +
      ((b[o + 2] ?? 0) << 8) +
      (b[o + 3] ?? 0)) >>>
    0
  );
}

function i32be(b: Uint8Array, o: number): number {
  return u32be(b, o) | 0;
}

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}

interface IndexEntry {
  tag: number;
  type: number;
  offset: number;
  count: number;
}

interface ParsedHeader {
  /** Absolute offset (in the whole file) where the data store begins. */
  storeStart: number;
  /** Absolute offset of the first byte past this header's store. */
  end: number;
  entries: Map<number, IndexEntry>;
  bytes: Uint8Array;
}

/** Parse one header structure starting at `start`, or null if it is malformed. */
function parseHeader(bytes: Uint8Array, start: number): ParsedHeader | null {
  if (start + HEADER_PREAMBLE_SIZE > bytes.length) return null;
  if (u32be(bytes, start) !== HEADER_MAGIC) return null;
  const nindex = u32be(bytes, start + 8);
  const hsize = u32be(bytes, start + 12);
  if (nindex > MAX_NINDEX || hsize > MAX_HSIZE) return null;

  const indexStart = start + HEADER_PREAMBLE_SIZE;
  const storeStart = indexStart + nindex * INDEX_ENTRY_SIZE;
  const end = storeStart + hsize;
  if (end > bytes.length) return null;

  const entries = new Map<number, IndexEntry>();
  for (let i = 0; i < nindex; i++) {
    const o = indexStart + i * INDEX_ENTRY_SIZE;
    const tag = u32be(bytes, o);
    const type = u32be(bytes, o + 4);
    const offset = u32be(bytes, o + 8);
    const count = u32be(bytes, o + 12);
    // First index entry for a tag wins (matches rpm's own behavior).
    if (!entries.has(tag)) entries.set(tag, { tag, type, offset, count });
  }
  return { storeStart, end, entries, bytes };
}

/** Read a NUL-terminated string from the data store at `offset`. */
function readCString(bytes: Uint8Array, storeStart: number, offset: number): string | null {
  const begin = storeStart + offset;
  if (begin < storeStart || begin >= bytes.length) return null;
  let cursor = begin;
  while (cursor < bytes.length && bytes[cursor] !== 0) cursor++;
  if (cursor >= bytes.length) return null;
  return new TextDecoder().decode(bytes.subarray(begin, cursor));
}

function readStringTag(header: ParsedHeader, entry: IndexEntry): string | null {
  if (
    entry.type !== TYPE_STRING &&
    entry.type !== TYPE_STRING_ARRAY &&
    entry.type !== TYPE_I18NSTRING
  ) {
    return null;
  }
  return readCString(header.bytes, header.storeStart, entry.offset);
}

function readIntTag(header: ParsedHeader, entry: IndexEntry): number | null {
  const at = header.storeStart + entry.offset;
  if (entry.type === TYPE_INT32) {
    if (at + 4 > header.bytes.length) return null;
    return i32be(header.bytes, at);
  }
  if (entry.type === TYPE_INT16) {
    if (at + 2 > header.bytes.length) return null;
    return u16be(header.bytes, at);
  }
  return null;
}

export interface RpmHeaderInfo {
  name?: string;
  version?: string;
  release?: string;
  arch?: string;
  summary?: string;
  /** Epoch as an integer; absent when the package declares no epoch. */
  epoch?: number;
}

/**
 * Read the package identity tags from an `.rpm`'s main header. Returns the tags
 * it could decode; absent tags are simply omitted so the caller can fall back to
 * filename parsing.
 */
export function readRpmHeaderInfo(rpm: Uint8Array): RpmHeaderInfo {
  // The lead is fixed at 96 bytes; the signature header follows immediately.
  const signature = parseHeader(rpm, LEAD_SIZE);
  if (!signature) return {};
  // The signature store is padded to an 8-byte boundary before the main header.
  const mainStart = signature.end + ((8 - (signature.end % 8)) % 8);
  const main = parseHeader(rpm, mainStart);
  if (!main) return {};

  const info: RpmHeaderInfo = {};
  const nameEntry = main.entries.get(RPM_TAG_NAME);
  if (nameEntry) {
    const name = readStringTag(main, nameEntry);
    if (name) info.name = name;
  }
  const versionEntry = main.entries.get(RPM_TAG_VERSION);
  if (versionEntry) {
    const version = readStringTag(main, versionEntry);
    if (version) info.version = version;
  }
  const releaseEntry = main.entries.get(RPM_TAG_RELEASE);
  if (releaseEntry) {
    const release = readStringTag(main, releaseEntry);
    if (release) info.release = release;
  }
  const archEntry = main.entries.get(RPM_TAG_ARCH);
  if (archEntry) {
    const arch = readStringTag(main, archEntry);
    if (arch) info.arch = arch;
  }
  const summaryEntry = main.entries.get(RPM_TAG_SUMMARY);
  if (summaryEntry) {
    const summary = readStringTag(main, summaryEntry);
    if (summary) info.summary = summary;
  }
  const epochEntry = main.entries.get(RPM_TAG_EPOCH);
  if (epochEntry) {
    const epoch = readIntTag(main, epochEntry);
    if (epoch !== null && epoch >= 0) info.epoch = epoch;
  }
  return info;
}
