import { describe, expect, test } from "bun:test";
import { isReadMethod, stripBodyForFallbackHead } from "./registry-utils";

describe("registry utils", () => {
  test("stripBodyForFallbackHead returns the response unchanged when no fallback occurred", () => {
    const res = new Response("body", { status: 200, headers: { "content-length": "4" } });
    expect(stripBodyForFallbackHead(false, res)).toBe(res);
  });

  test("stripBodyForFallbackHead removes the body and preserves headers for HEAD fallbacks", async () => {
    const res = new Response("body", {
      status: 206,
      statusText: "Partial Content",
      headers: { "content-length": "4", "content-type": "text/plain" },
    });
    const stripped = stripBodyForFallbackHead(true, res);
    expect(stripped.status).toBe(206);
    expect(stripped.statusText).toBe("Partial Content");
    expect(stripped.headers.get("content-length")).toBe("4");
    expect(stripped.headers.get("content-type")).toBe("text/plain");
    expect(await stripped.text()).toBe("");
  });

  test("re-exports runtime read-method classification", () => {
    expect(isReadMethod("GET")).toBe(true);
    expect(isReadMethod("HEAD")).toBe(true);
    expect(isReadMethod("PUT")).toBe(false);
  });
});
