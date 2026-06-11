import { afterEach, describe, expect, mock, test } from "bun:test";
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

/**
 * serveWebFallback reads from a built SPA dir on disk. Mock node:fs readdirSync
 * (so the dir tree is in-memory) and Bun.file (so no bytes are read), and point
 * env.WEB_DIST at a virtual root. The fallback's caching cache is keyed by root,
 * so each test uses a fresh root to avoid cross-test cache bleed.
 */
async function loadServeWebFallback(opts: { webDist: string | undefined; files: string[] }) {
  const realConfig = await import("@hootifactory/config");
  const realFs = await import("node:fs");
  await mock.module("@hootifactory/config", () => ({
    ...realConfig,
    env: { ...realConfig.env, WEB_DIST: opts.webDist },
  }));
  await mock.module("node:fs", () => ({
    ...realFs,
    readdirSync: (dir: string) => {
      // Flat in-memory tree: every fixture file is a direct child of the root.
      if (dir !== opts.webDist) return [];
      return opts.files.map((name) => ({
        name,
        isDirectory: () => false,
        isFile: () => true,
      }));
    },
  }));
  (globalThis as any).Bun.file = (path: string) => `FILE(${path})`;
  return import("./web-fallback");
}

describe("serveWebFallback", () => {
  const realBunFile = Bun.file;
  afterEach(() => {
    mock.restore();
    (globalThis as any).Bun.file = realBunFile;
  });

  test("returns null when WEB_DIST is not configured", async () => {
    const { serveWebFallback } = await loadServeWebFallback({ webDist: undefined, files: [] });
    expect(await serveWebFallback("/dashboard")).toBeNull();
  });

  test("returns null for reserved server paths even when WEB_DIST is set", async () => {
    const { serveWebFallback } = await loadServeWebFallback({
      webDist: "/web-1",
      files: ["index.html"],
    });
    expect(await serveWebFallback("/api/repositories")).toBeNull();
    expect(await serveWebFallback("/npm/acme/pkg", { registryMountSegments: ["npm"] })).toBeNull();
  });

  test("serves a matched built asset with immutable cache headers", async () => {
    const { serveWebFallback } = await loadServeWebFallback({
      webDist: "/web-2",
      files: ["index.html", "assets/app.js"],
    });
    const res = await serveWebFallback("/assets/app.js");
    expect(res).not.toBeNull();
    expect(res?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("falls back to index.html for an unmatched SPA route", async () => {
    const { serveWebFallback } = await loadServeWebFallback({
      webDist: "/web-3",
      files: ["index.html"],
    });
    const res = await serveWebFallback("/dashboard/settings");
    expect(res).not.toBeNull();
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(res?.headers.get("cache-control")).toBe("no-cache");
  });

  test("returns null when there is no index.html to fall back to", async () => {
    const { serveWebFallback } = await loadServeWebFallback({ webDist: "/web-4", files: [] });
    expect(await serveWebFallback("/dashboard")).toBeNull();
  });

  test("never serves a path-traversal request", async () => {
    const { serveWebFallback } = await loadServeWebFallback({
      webDist: "/web-5",
      files: ["index.html", "secret"],
    });
    // ".." short-circuits the direct-file branch and falls back to index.html.
    const res = await serveWebFallback("/../secret");
    expect(res?.headers.get("content-type")).toContain("text/html");
  });
});
