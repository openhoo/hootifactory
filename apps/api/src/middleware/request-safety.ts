import { env } from "@hootifactory/config";
import { RegistryError, z } from "@hootifactory/core";
import { addSpanEvent } from "@hootifactory/observability";
import type { Context } from "hono";
import { logger } from "../lib/logger";
import type { AppEnv } from "../types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ContentLengthHeaderSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value));

function parseContentLength(value: string | undefined): number | "invalid" | null {
  if (value == null) return null;
  const parsed = ContentLengthHeaderSchema.safeParse(value);
  return parsed.success ? parsed.data : "invalid";
}

function registryPathname(pathname: string): string | null {
  return pathname.startsWith("/v2/") && pathname !== "/v2/" ? pathname : null;
}

function trustedOriginsForRequest(requestUrl: string): Set<string> {
  const origins = new Set(env.API_TRUSTED_ORIGINS);
  origins.add(new URL(requestUrl).origin);
  origins.add(new URL(env.REGISTRY_PUBLIC_URL).origin);
  return origins;
}

function isTrustedOrigin(requestUrl: string, origin: string): boolean {
  try {
    return trustedOriginsForRequest(requestUrl).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function rejectsCookieCsrf(c: Context<AppEnv>): boolean {
  if (SAFE_METHODS.has(c.req.method)) return false;
  if (c.get("authSource") !== "session") return false;
  const origin = c.req.header("origin");
  if (origin) return !isTrustedOrigin(c.req.url, origin);
  const fetchSite = c.req.header("sec-fetch-site");
  return fetchSite === "cross-site" || fetchSite === "same-site";
}

export async function enforceRequestBodyLimits(
  c: Context<AppEnv>,
  next: () => Promise<void>,
): Promise<Response | undefined> {
  const pathname = c.req.path;
  const contentLength = parseContentLength(c.req.header("content-length"));
  const registryPath = registryPathname(pathname);
  if (contentLength === "invalid") {
    addSpanEvent("http.request.invalid_content_length");
    logger.debug("invalid content-length rejected", {
      method: c.req.method,
      path: pathname,
    });
    if (registryPath) {
      return new RegistryError(400, "SIZE_INVALID", "invalid content-length").toResponse();
    }
    return c.json({ errors: [{ code: "BAD_REQUEST", message: "invalid content-length" }] }, 400);
  }
  if (contentLength != null && contentLength > env.REGISTRY_MAX_UPLOAD_BYTES) {
    addSpanEvent("http.request.payload_too_large", {
      "http.request.body.size": contentLength,
      "http.request.body.size_limit": env.REGISTRY_MAX_UPLOAD_BYTES,
    });
    logger.debug("oversized request rejected", {
      method: c.req.method,
      path: pathname,
      contentLength,
      limit: env.REGISTRY_MAX_UPLOAD_BYTES,
    });
    if (registryPath) {
      return new RegistryError(
        413,
        registryPath.includes("/manifests/") ? "MANIFEST_INVALID" : "SIZE_INVALID",
        `request body exceeds ${env.REGISTRY_MAX_UPLOAD_BYTES} bytes`,
      ).toResponse();
    }
    return c.json(
      {
        errors: [
          {
            code: "PAYLOAD_TOO_LARGE",
            message: `request body exceeds ${env.REGISTRY_MAX_UPLOAD_BYTES} bytes`,
          },
        ],
      },
      413,
    );
  }
  await next();
}

export async function rejectCrossOriginSessionWrites(
  c: Context<AppEnv>,
  next: () => Promise<void>,
): Promise<Response | undefined> {
  if (rejectsCookieCsrf(c)) {
    addSpanEvent("auth.csrf_rejected", { "auth.source": c.get("authSource") });
    logger.warn("cross-origin session request denied", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      origin: c.req.header("origin"),
      fetchSite: c.req.header("sec-fetch-site"),
    });
    return c.json({ error: "cross-origin session request denied" }, 403);
  }
  await next();
}
