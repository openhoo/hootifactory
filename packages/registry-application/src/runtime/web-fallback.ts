import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { env } from "@hootifactory/config";

/** Reserved server path segments that must never fall back to the SPA index.html. */
const RESERVED_SERVER_SEGMENTS = new Set(["api", "v2", "token", "healthz", "readyz"]);
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const INDEX_CACHE_CONTROL = "no-cache";

let webDistCache: { root: string; files: Set<string> } | null = null;

function webPath(path: string): string {
  return path.split(sep).join("/");
}

function collectWebDistFiles(root: string): Set<string> {
  const files = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.add(webPath(relative(root, path)));
      }
    }
  };
  try {
    visit(root);
  } catch {
    return new Set();
  }
  return files;
}

function webDistFiles(root: string): Set<string> {
  if (webDistCache?.root !== root) {
    webDistCache = { root, files: collectWebDistFiles(root) };
  }
  return webDistCache.files;
}

export function isReservedWebPath(
  cleanPath: string,
  registryMountSegments: Iterable<string> = [],
): boolean {
  const first = cleanPath.split("/", 1)[0] ?? "";
  return RESERVED_SERVER_SEGMENTS.has(first) || new Set(registryMountSegments).has(first);
}

export function webCacheHeaders(cleanPath: string): Record<string, string> {
  return cleanPath.startsWith("assets/")
    ? { "cache-control": IMMUTABLE_ASSET_CACHE_CONTROL }
    : { "cache-control": INDEX_CACHE_CONTROL };
}

/** Serve the built SPA (assets + index.html fallback) for single-container deploys. */
export async function serveWebFallback(
  pathname: string,
  opts: { registryMountSegments?: Iterable<string> } = {},
): Promise<Response | null> {
  if (!env.WEB_DIST) return null;
  const clean = pathname.replace(/^\/+/, "");
  // API/registry routes must return their real JSON 404, not the SPA shell.
  if (isReservedWebPath(clean, opts.registryMountSegments)) return null;
  const files = webDistFiles(env.WEB_DIST);
  if (clean && !clean.includes("..")) {
    if (files.has(clean)) {
      return new Response(Bun.file(join(env.WEB_DIST, clean)), {
        headers: webCacheHeaders(clean),
      });
    }
  }
  if (files.has("index.html")) {
    return new Response(Bun.file(join(env.WEB_DIST, "index.html")), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...webCacheHeaders("index.html"),
      },
    });
  }
  return null;
}
