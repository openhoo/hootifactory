import { describe, expect, test } from "bun:test";
import { memoizeByKey } from "./memo";

describe("memoizeByKey", () => {
  test("caches falsy values", () => {
    let calls = 0;
    const load = memoizeByKey((key: string) => {
      calls += 1;
      return key === "missing" ? null : 0;
    });

    expect(load("missing")).toBeNull();
    expect(load("missing")).toBeNull();
    expect(load("zero")).toBe(0);
    expect(load("zero")).toBe(0);
    expect(calls).toBe(2);
  });
});
