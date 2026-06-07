import { describe, expect, test } from "bun:test";
import { RegistryError } from "./errors";
import {
  asJsonRecord,
  jsonRecordOrEmpty,
  parseJsonWithSchema,
  parseRegistryInput,
  safeJsonParse,
  z,
  zodIssueTree,
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

describe("parseRegistryInput", () => {
  const schema = z.strictObject({ name: z.string().min(1) });

  test("returns parsed data for valid input", () => {
    expect(parseRegistryInput(schema, { name: "pkg" })).toEqual({ name: "pkg" });
  });

  test("throws a RegistryError with defaults for invalid input", () => {
    let thrown: unknown;
    try {
      parseRegistryInput(schema, { name: "" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegistryError);
    const err = thrown as RegistryError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toBe("invalid request");
    expect(err.detail).toBeDefined();
  });

  test("honors caller-provided status, code, and message overrides", () => {
    expect(() =>
      parseRegistryInput(schema, 42, {
        status: 422,
        code: "NAME_INVALID",
        message: "bad name",
      }),
    ).toThrow("bad name");
    try {
      parseRegistryInput(schema, 42, { status: 422, code: "NAME_INVALID" });
    } catch (error) {
      expect((error as RegistryError).status).toBe(422);
      expect((error as RegistryError).code).toBe("NAME_INVALID");
    }
  });
});

describe("zodIssueTree", () => {
  test("treeifies a Zod error into a structured shape", () => {
    const result = z.strictObject({ name: z.string() }).safeParse({ name: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const tree = zodIssueTree(result.error) as { properties?: Record<string, unknown> };
      expect(tree.properties).toBeDefined();
      expect(tree.properties?.name).toBeDefined();
    }
  });
});
