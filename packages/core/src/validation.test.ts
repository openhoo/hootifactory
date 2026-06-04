import { describe, expect, test } from "bun:test";
import {
  asJsonRecord,
  jsonRecordOrEmpty,
  parseJsonWithSchema,
  safeJsonParse,
  z,
} from "./validation";

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

  test("parse JSON with a discriminated result", () => {
    expect(safeJsonParse('{"ok":true}')).toEqual({ success: true, data: { ok: true } });
    const malformed = safeJsonParse("{");
    expect(malformed.success).toBe(false);
    if (!malformed.success) expect(malformed.error).toBeInstanceOf(SyntaxError);
  });

  test("parse JSON through a Zod schema without throwing", () => {
    const schema = z.strictObject({ ok: z.boolean() });
    expect(parseJsonWithSchema(schema, '{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonWithSchema(schema, '{"ok":"yes"}')).toBeNull();
    expect(parseJsonWithSchema(schema, "{")).toBeNull();
  });
});
