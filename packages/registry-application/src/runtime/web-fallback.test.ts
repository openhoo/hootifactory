import { describe, expect, test } from "bun:test";
import { isReservedWebPath, webCacheHeaders } from "./web-fallback";

describe("web fallback helpers", () => {
  test("detects reserved server path segments without prefix collisions", () => {
    expect(isReservedWebPath("api")).toBe(true);
    expect(isReservedWebPath("api/repositories")).toBe(true);
    expect(isReservedWebPath("module/acme/pkg", ["module"])).toBe(true);
    expect(isReservedWebPath("module/acme/pkg")).toBe(false);
    expect(isReservedWebPath("apiary")).toBe(false);
    expect(isReservedWebPath("assets/index.js")).toBe(false);
  });

  test("uses immutable cache headers for built assets and no-cache for the shell", () => {
    expect(webCacheHeaders("assets/index-BIZhAknC.js")).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
    });
    expect(webCacheHeaders("index.html")).toEqual({ "cache-control": "no-cache" });
    expect(webCacheHeaders("dashboard")).toEqual({ "cache-control": "no-cache" });
  });
});
