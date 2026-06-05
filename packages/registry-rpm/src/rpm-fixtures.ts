/**
 * Test-only helpers for hand-constructing a minimal `.rpm` buffer:
 * a 96-byte lead, a (near-empty) signature header padded to an 8-byte boundary,
 * and a main header carrying the requested string/int tags.
 */

const HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01];
const TYPE_INT32 = 4;
const TYPE_STRING = 6;

interface TagInput {
  tag: number;
  type: typeof TYPE_STRING | typeof TYPE_INT32;
  value: string | number;
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Build a header structure (preamble + index + store) from the given tags. */
function buildHeader(tags: TagInput[]): Uint8Array {
  const index: number[] = [];
  const store: number[] = [];
  const enc = new TextEncoder();

  for (const t of tags) {
    const offset = store.length;
    if (t.type === TYPE_STRING) {
      const bytes = [...enc.encode(String(t.value)), 0];
      store.push(...bytes);
      index.push(...u32be(t.tag), ...u32be(TYPE_STRING), ...u32be(offset), ...u32be(1));
    } else {
      store.push(...u32be(Number(t.value)));
      index.push(...u32be(t.tag), ...u32be(TYPE_INT32), ...u32be(offset), ...u32be(1));
    }
  }

  const preamble = [
    ...HEADER_MAGIC,
    0,
    0,
    0,
    0, // reserved
    ...u32be(tags.length), // nindex
    ...u32be(store.length), // hsize
  ];
  return new Uint8Array([...preamble, ...index, ...store]);
}

export interface MinimalRpmInput {
  name?: string;
  version?: string;
  release?: string;
  arch?: string;
  summary?: string;
  epoch?: number;
  /** Extra trailing payload bytes appended after the headers (the "archive"). */
  payload?: Uint8Array;
}

const RPM_TAG_NAME = 1000;
const RPM_TAG_VERSION = 1001;
const RPM_TAG_RELEASE = 1002;
const RPM_TAG_EPOCH = 1003;
const RPM_TAG_SUMMARY = 1004;
const RPM_TAG_ARCH = 1022;

/** Construct a minimal but structurally-valid `.rpm` buffer. */
export function buildMinimalRpm(input: MinimalRpmInput): Uint8Array {
  const lead = new Uint8Array(96);
  // RPM lead magic ED AB EE DB (cosmetic; the reader skips the lead).
  lead.set([0xed, 0xab, 0xee, 0xdb], 0);

  // A tiny signature header (one INT32 tag) so alignment is exercised.
  const signature = buildHeader([{ tag: 62, type: TYPE_INT32, value: 16 }]);
  const sigPad = new Uint8Array((8 - (signature.length % 8)) % 8);

  const tags: TagInput[] = [];
  if (input.name !== undefined)
    tags.push({ tag: RPM_TAG_NAME, type: TYPE_STRING, value: input.name });
  if (input.version !== undefined)
    tags.push({ tag: RPM_TAG_VERSION, type: TYPE_STRING, value: input.version });
  if (input.release !== undefined)
    tags.push({ tag: RPM_TAG_RELEASE, type: TYPE_STRING, value: input.release });
  if (input.epoch !== undefined)
    tags.push({ tag: RPM_TAG_EPOCH, type: TYPE_INT32, value: input.epoch });
  if (input.summary !== undefined)
    tags.push({ tag: RPM_TAG_SUMMARY, type: TYPE_STRING, value: input.summary });
  if (input.arch !== undefined)
    tags.push({ tag: RPM_TAG_ARCH, type: TYPE_STRING, value: input.arch });

  const main = buildHeader(tags);
  const payload = input.payload ?? new Uint8Array([1, 2, 3, 4]);

  return new Uint8Array([...lead, ...signature, ...sigPad, ...main, ...payload]);
}
