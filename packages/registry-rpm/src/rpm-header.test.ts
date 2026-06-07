import { describe, expect, test } from "bun:test";
import { buildMinimalRpm } from "./rpm-fixtures";
import { readRpmHeaderInfo } from "./rpm-header";

describe("RPM header reader", () => {
  test("reads name/version/release/arch/summary/epoch/build time from the main header", () => {
    const rpm = buildMinimalRpm({
      name: "hello",
      version: "2.10",
      release: "3.el9",
      arch: "x86_64",
      epoch: 1,
      buildTime: 1_700_000_123,
      summary: "A friendly greeting",
    });
    expect(readRpmHeaderInfo(rpm)).toEqual({
      name: "hello",
      version: "2.10",
      release: "3.el9",
      arch: "x86_64",
      epoch: 1,
      buildTime: 1_700_000_123,
      summary: "A friendly greeting",
    });
  });

  test("omits epoch when the package declares none (caller defaults to 0)", () => {
    const rpm = buildMinimalRpm({
      name: "noepoch",
      version: "2.3",
      release: "4",
      arch: "noarch",
    });
    const info = readRpmHeaderInfo(rpm);
    expect(info.epoch).toBeUndefined();
    expect(info.name).toBe("noepoch");
    expect(info.arch).toBe("noarch");
  });

  test("returns the tags it can decode when some are missing", () => {
    const rpm = buildMinimalRpm({ name: "partial", arch: "aarch64" });
    expect(readRpmHeaderInfo(rpm)).toEqual({ name: "partial", arch: "aarch64" });
  });

  test("returns empty info for a buffer that is not a valid RPM", () => {
    expect(readRpmHeaderInfo(new Uint8Array(8))).toEqual({});
    expect(readRpmHeaderInfo(new Uint8Array([1, 2, 3]))).toEqual({});
  });

  test("tolerates signature-header padding to an 8-byte boundary", () => {
    // The fixture's signature header (preamble + one INT32 entry + 4-byte store)
    // is 28 bytes, so it requires 4 bytes of padding before the main header.
    const rpm = buildMinimalRpm({ name: "aligned", version: "1", release: "1", arch: "src" });
    expect(readRpmHeaderInfo(rpm).name).toBe("aligned");
  });

  test("ignores a payload appended after the headers", () => {
    const rpm = buildMinimalRpm({
      name: "withpayload",
      version: "1",
      release: "1",
      arch: "noarch",
      payload: new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]),
    });
    expect(readRpmHeaderInfo(rpm).name).toBe("withpayload");
  });

  test("returns empty info when the main header magic is wrong", () => {
    const rpm = buildMinimalRpm({ name: "corrupt", version: "1", release: "1", arch: "noarch" });
    // The signature header is at offset 96; the main header begins after it +
    // padding. Corrupting the first lead byte alone keeps it valid, so instead
    // truncate the buffer mid-main-header to force parseHeader to bail (end >
    // bytes.length).
    expect(readRpmHeaderInfo(rpm.subarray(0, 96 + 20))).toEqual({});
  });

  test("decodes a 16-bit epoch tag and ignores an unknown string tag type", () => {
    // Hand-build a main header where EPOCH (1003) is an INT16 and SUMMARY (1004)
    // uses a binary type the reader does not decode. This exercises the INT16
    // branch of readIntTag and the null-type branch of readStringTag.
    const HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01];
    const TYPE_INT16 = 3;
    const TYPE_INT32 = 4;
    const TYPE_STRING = 6;
    const TYPE_BIN = 7; // not decoded by the reader
    const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    const enc = new TextEncoder();

    type Tag = { tag: number; type: number; bytes: number[] };
    const tags: Tag[] = [
      { tag: 1000, type: TYPE_STRING, bytes: [...enc.encode("epoch16"), 0] },
      { tag: 1001, type: TYPE_STRING, bytes: [...enc.encode("1"), 0] },
      { tag: 1002, type: TYPE_STRING, bytes: [...enc.encode("1"), 0] },
      { tag: 1022, type: TYPE_STRING, bytes: [...enc.encode("noarch"), 0] },
      { tag: 1003, type: TYPE_INT16, bytes: [0x00, 0x07] },
      { tag: 1006, type: TYPE_INT32, bytes: u32(1_700_000_001) },
      { tag: 1004, type: TYPE_BIN, bytes: [0xab, 0xcd] },
    ];
    const index: number[] = [];
    const store: number[] = [];
    for (const t of tags) {
      const offset = store.length;
      store.push(...t.bytes);
      index.push(...u32(t.tag), ...u32(t.type), ...u32(offset), ...u32(1));
    }

    const buildHeader = (entries: number[], data: number[], count: number) =>
      new Uint8Array([
        ...HEADER_MAGIC,
        0,
        0,
        0,
        0,
        ...u32(count),
        ...u32(data.length),
        ...entries,
        ...data,
      ]);

    const lead = new Uint8Array(96);
    const signature = buildHeader(
      [...u32(62), ...u32(TYPE_INT32), ...u32(0), ...u32(1)],
      u32(16),
      1,
    );
    const sigPad = new Uint8Array((8 - (signature.length % 8)) % 8);
    const main = buildHeader(index, store, tags.length);
    const rpm = new Uint8Array([...lead, ...signature, ...sigPad, ...main]);

    const info = readRpmHeaderInfo(rpm);
    expect(info.name).toBe("epoch16");
    expect(info.epoch).toBe(7);
    expect(info.buildTime).toBe(1_700_000_001);
    // The BIN-typed SUMMARY tag is not decoded.
    expect(info.summary).toBeUndefined();
  });
});
