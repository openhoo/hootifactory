import { env } from "@hootifactory/config";
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

const SENSITIVE_CACHE_HEADERS = {
  "cache-control": "no-store",
  vary: "Authorization, Cookie, X-NuGet-ApiKey",
};

function isApiOrTokenPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/token" ||
    pathname.startsWith("/token/")
  );
}

function hasRequestCredentials(headers: Headers): boolean {
  return headers.has("authorization") || headers.has("cookie") || headers.has("x-nuget-apikey");
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
): Record<string, string> {
  const pathname = new URL(request.url).pathname;
  return {
    ...securityHeadersForNodeEnv(nodeEnv),
    ...(isApiOrTokenPath(pathname) || hasRequestCredentials(request.headers)
      ? SENSITIVE_CACHE_HEADERS
      : {}),
  };
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next();
  } finally {
    for (const [name, value] of Object.entries(
      securityHeadersForRequest(env.NODE_ENV, c.req.raw),
    )) {
      c.header(name, value);
    }
  }
};
