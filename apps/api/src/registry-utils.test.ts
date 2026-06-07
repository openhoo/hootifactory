import { describe, expect, test } from "bun:test";
import {
  headersWithoutContentLength,
  isReadMethod,
  stripBodyForFallbackHead,
} from "./registry-utils";

describe("registry utils", () => {
  test("headersWithoutContentLength drops content-length and copies the rest", () => {
    const original = new Headers({
      "content-length": "123",
      "content-type": "application/json",
      etag: '"v1"',
    });
    const next = headersWithoutContentLength(original);
    expect(next.get("content-length")).toBeNull();
    expect(next.get("content-type")).toBe("application/json");
    expect(next.get("etag")).toBe('"v1"');
    // The source headers are not mutated.
    expect(original.get("content-length")).toBe("123");
  });

  test("stripBodyForFallbackHead returns the response unchanged when no fallback occurred", () => {
    const res = new Response("body", { status: 200, headers: { "content-length": "4" } });
    expect(stripBodyForFallbackHead(false, res)).toBe(res);
  });

  test("stripBodyForFallbackHead removes the body and content-length for HEAD fallbacks", async () => {
    const res = new Response("body", {
      status: 206,
      statusText: "Partial Content",
      headers: { "content-length": "4", "content-type": "text/plain" },
    });
    const stripped = stripBodyForFallbackHead(true, res);
    expect(stripped.status).toBe(206);
    expect(stripped.statusText).toBe("Partial Content");
    expect(stripped.headers.get("content-length")).toBeNull();
    expect(stripped.headers.get("content-type")).toBe("text/plain");
    expect(await stripped.text()).toBe("");
  });

  test("re-exports runtime read-method classification", () => {
    expect(isReadMethod("GET")).toBe(true);
    expect(isReadMethod("HEAD")).toBe(true);
    expect(isReadMethod("PUT")).toBe(false);
  });
});
