import { join } from "node:path";
import { env } from "@hootifactory/config";

/** Reserved server path segments that must never fall back to the SPA index.html. */
const RESERVED_SEGMENTS = [
  "api",
  "v2",
  "token",
  "healthz",
  "readyz",
  "npm",
  "pypi",
  "go",
  "cargo",
  "nuget",
];

/** Serve the built SPA (assets + index.html fallback) for single-container deploys. */
export async function serveWebFallback(pathname: string): Promise<Response | null> {
  if (!env.WEB_DIST) return null;
  const clean = pathname.replace(/^\/+/, "");
  // API/registry routes must return their real JSON 404, not the SPA shell.
  if (RESERVED_SEGMENTS.some((s) => clean === s || clean.startsWith(`${s}/`))) return null;
  if (clean && !clean.includes("..")) {
    const file = Bun.file(join(env.WEB_DIST, clean));
    if (await file.exists()) return new Response(file);
  }
  const index = Bun.file(join(env.WEB_DIST, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return null;
}
