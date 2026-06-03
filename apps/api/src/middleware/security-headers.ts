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

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  for (const [name, value] of Object.entries(securityHeadersForNodeEnv(env.NODE_ENV))) {
    c.header(name, value);
  }
  await next();
};
