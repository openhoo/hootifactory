import { env } from "@hootifactory/config";
import { RegistryError } from "@hootifactory/core";
import { type Context, Hono } from "hono";
import { logger } from "./lib/logger";
import { authenticate } from "./middleware/authenticate";
import { handleRegistryRequest } from "./registry";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { tokenRouter } from "./routes/token";
import { uiRouter } from "./routes/ui";
import { v2VersionCheck } from "./routes/v2";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>();

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function parseContentLength(value: string | undefined): number | "invalid" | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function registryPathname(url: string): string | null {
  const pathname = new URL(url).pathname;
  return pathname === "/v2" || pathname === "/v2/" || pathname.startsWith("/v2/") ? pathname : null;
}

app.use("*", async (c, next) => {
  const contentLength = parseContentLength(c.req.header("content-length"));
  const registryPath = registryPathname(c.req.url);
  if (contentLength === "invalid") {
    if (registryPath) {
      return new RegistryError(400, "SIZE_INVALID", "invalid content-length").toResponse();
    }
    return c.json({ errors: [{ code: "BAD_REQUEST", message: "invalid content-length" }] }, 400);
  }
  if (contentLength != null && contentLength > env.REGISTRY_MAX_UPLOAD_BYTES) {
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
});

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

// Identity for every request (defaults to anonymous).
app.use("*", async (c, next) => {
  c.set("principal", await authenticate(c));
  await next();
});

app.use("*", async (c, next) => {
  if (rejectsCookieCsrf(c)) {
    return c.json({ error: "cross-origin session request denied" }, 403);
  }
  await next();
});

app.onError((err, c) => {
  if (err instanceof RegistryError) return err.toResponse();
  logger.error("unhandled error", { error: err instanceof Error ? err.message : String(err) });
  return c.json({ errors: [{ code: "INTERNAL", message: "internal server error" }] }, 500);
});

// Explicit app routes (evaluated before the registry catch-all).
app.route("/", healthRouter);
app.route("/api/auth", authRouter);
app.route("/api", uiRouter);
app.route("/token", tokenRouter);

// OCI version check — exact paths only; deeper /v2/<name>/... falls through.
app.get("/v2", v2VersionCheck);
app.get("/v2/", v2VersionCheck);
app.on("HEAD", "/v2", v2VersionCheck);
app.on("HEAD", "/v2/", v2VersionCheck);

// Everything else is registry traffic.
app.all("*", (c) => handleRegistryRequest(c));
