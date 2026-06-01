import { describe, expect, test } from "bun:test";
import { attributesForMeta, safeJsonStringify, sanitizeForJson } from "./log-format";

describe("log formatting helpers", () => {
  test("sanitizes circular, binary, bigint, and throwing metadata", () => {
    const value: Record<string, unknown> = {
      bytes: new Uint8Array([1, 2, 3]),
      count: 3n,
    };
    value.self = value;
    Object.defineProperty(value, "danger", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    expect(sanitizeForJson(value)).toEqual({
      bytes: { type: "Uint8Array", byteLength: 3 },
      count: "3",
      self: "[Circular]",
      danger: "[Thrown: getter failed]",
    });
  });

  test("extracts bounded OpenTelemetry attributes from scalar and structured metadata", () => {
    const attrs = attributesForMeta({
      format: "npm",
      durationMs: 12.5,
      ok: true,
      nested: { value: "kept" },
      error: new Error("broken"),
    });

    expect(attrs).toMatchObject({
      "exception.type": "Error",
      "exception.message": "broken",
      "meta.format": "npm",
      "meta.durationMs": 12.5,
      "meta.ok": true,
      "meta.nested": '{"value":"kept"}',
    });
  });

  test("returns a fallback log line when JSON serialization fails", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(JSON.parse(safeJsonStringify(cyclic))).toMatchObject({
      level: "error",
      msg: "failed to serialize log line",
      meta: "JSON.stringify cannot serialize cyclic structures.",
    });
  });
});
