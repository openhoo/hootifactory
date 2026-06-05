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
});
