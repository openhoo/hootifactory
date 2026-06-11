import { describe, expect, test } from "bun:test";
import { booleanField, dateField, numberField, rowsFromExecute, stringField } from "./raw-rows";

describe("raw SQL row helpers", () => {
  test("normalizes execute results from arrays and row-bearing objects", () => {
    const rows = [{ id: "one" }];
    expect(rowsFromExecute(rows)).toEqual(rows);
    expect(rowsFromExecute({ rows })).toEqual(rows);
    expect(rowsFromExecute({ rows: "not rows" })).toEqual([]);
    expect(rowsFromExecute(null)).toEqual([]);
  });

  test("coerces primitive fields conservatively", () => {
    const now = new Date("2026-06-04T12:00:00.000Z");
    expect(stringField({ value: "ok" }, "value")).toBe("ok");
    expect(stringField({ value: 1 }, "value")).toBeNull();
    expect(numberField({ value: "42" }, "value")).toBe(42);
    expect(numberField({ value: "1.5" }, "value")).toBeNull();
    expect(dateField({ value: now }, "value")).toBe(now);
    expect(dateField({ value: now.toISOString() }, "value")?.toISOString()).toBe(now.toISOString());
    expect(booleanField({ value: 1 }, "value")).toBe(true);
    expect(booleanField({ value: 0 }, "value")).toBe(false);
  });
});
