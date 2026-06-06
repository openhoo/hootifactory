import { describe, expect, test } from "bun:test";
import { stripTrailingSlashes, trimChar } from "./strings";

describe("trimChar", () => {
  test("trims leading and trailing occurrences of the char", () => {
    expect(trimChar("//a/b//", "/")).toBe("a/b");
    expect(trimChar("--a-b--", "-")).toBe("a-b");
  });

  test("leaves interior runs of the char intact", () => {
    expect(trimChar("/a//b/", "/")).toBe("a//b");
  });

  test("handles empty, all-char, and no-match inputs", () => {
    expect(trimChar("", "/")).toBe("");
    expect(trimChar("///", "/")).toBe("");
    expect(trimChar("abc", "/")).toBe("abc");
  });
});

describe("stripTrailingSlashes", () => {
  test("strips trailing slashes only", () => {
    expect(stripTrailingSlashes("https://x/")).toBe("https://x");
    expect(stripTrailingSlashes("https://x///")).toBe("https://x");
  });

  test("keeps leading and interior slashes", () => {
    expect(stripTrailingSlashes("//a/b")).toBe("//a/b");
  });

  test("preserves nullish/empty input for `|| fallback` callers", () => {
    expect(stripTrailingSlashes(undefined)).toBeUndefined();
    expect(stripTrailingSlashes("")).toBe("");
  });
});
