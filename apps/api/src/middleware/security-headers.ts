import { env } from "@hootifactory/config";
import { isImmutableContentPath, registryPlugins } from "@hootifactory/registry";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
].join("; ");

function registryApiKeyHeaders(): string[] {
  // Memoized on the plugin set so the credentialed-response hot path doesn't
  // re-flatMap every plugin's headers on each request.
  return registryPlugins.derive("apiKeyHeaders", () =>
    registryPlugins.all().flatMap((plugin) => [...plugin.apiKeyHeaders]),
  );
}

function sensitiveVaryHeader(): string {
  return registryPlugins.derive("sensitiveVary", () =>
    ["Authorization", "Cookie", ...registryApiKeyHeaders()].join(", "),
  );
}

function sensitiveCacheHeaders(): Record<string, string> {
  return { "cache-control": "no-store", vary: sensitiveVaryHeader() };
}

function isApiOrTokenPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/token" ||
    pathname.startsWith("/token/")
  );
}

function hasRequestCredentials(headers: Headers): boolean {
  return (
    headers.has("authorization") ||
    headers.has("cookie") ||
    registryApiKeyHeaders().some((header) => headers.has(header))
  );
}

function isImmutableCacheControl(value: string | null): boolean {
  return value?.toLowerCase().includes("immutable") ?? false;
}

export function securityHeadersForNodeEnv(nodeEnv: string): Record<string, string> {
  return {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...(nodeEnv === "production"
      ? { "strict-transport-security": "max-age=63072000; includeSubDomains" }
      : {}),
  };
}

export function securityHeadersForRequest(
  nodeEnv: string,
  request: Request,
  pathname = new URL(request.url).pathname,
): Record<string, string> {
  const shouldForceNoStore =
    isApiOrTokenPath(pathname) ||
    (hasRequestCredentials(request.headers) && !isImmutableContentPath(pathname));
  return {
    ...securityHeadersForNodeEnv(nodeEnv),
    ...(shouldForceNoStore ? sensitiveCacheHeaders() : {}),
  };
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next();
  } finally {
    const existingCacheControl = c.res.headers.get("cache-control");
    for (const [name, value] of Object.entries(
      securityHeadersForRequest(env.NODE_ENV, c.req.raw, c.req.path),
    )) {
      if (name === "cache-control" && isImmutableCacheControl(existingCacheControl)) continue;
      c.header(name, value);
    }
  }
};
