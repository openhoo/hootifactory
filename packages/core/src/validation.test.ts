import { describe, expect, test } from "bun:test";
import { asJsonRecord, jsonRecordOrEmpty } from "./validation";

describe("json record validation helpers", () => {
  test("accept plain JSON records and reject non-record values", () => {
    expect(asJsonRecord({ a: 1, b: "two" })).toEqual({ a: 1, b: "two" });
    expect(asJsonRecord(null)).toBeNull();
    expect(asJsonRecord(["not", "a", "record"])).toBeNull();
    expect(asJsonRecord("not a record")).toBeNull();
  });

  test("provide an empty-object fallback for optional JSON records", () => {
    expect(jsonRecordOrEmpty({ nested: { ok: true } })).toEqual({ nested: { ok: true } });
    expect(jsonRecordOrEmpty(undefined)).toEqual({});
  });
});
