import { RegistryError } from "@hootifactory/core";
import {
  initializeObservability,
  instrumentHttpRequest,
  setActiveSpanAttributes,
} from "@hootifactory/observability";
import { Hono } from "hono";
import { logger } from "./lib/logger";
import { authenticate } from "./middleware/authenticate";
import {
  enforceRequestBodyLimits,
  rejectCrossOriginSessionWrites,
} from "./middleware/request-safety";
import { handleRegistryRequest } from "./registry";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { tokenRouter } from "./routes/token";
import { uiRouter } from "./routes/ui";
import { v2VersionCheck } from "./routes/v2";
import type { AppEnv } from "./types";

initializeObservability({ serviceRole: "api" });

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await instrumentHttpRequest(c.req.raw, async (telemetry) => {
    c.set("requestId", telemetry.requestId);
    c.set("correlationId", telemetry.correlationId);
    c.header("x-request-id", telemetry.requestId);
    c.header("x-correlation-id", telemetry.correlationId);
    await next();
    telemetry.setStatusCode(c.res.status || 200);
  });
});

app.use("*", enforceRequestBodyLimits);

// Identity for every request (defaults to anonymous).
app.use("*", async (c, next) => {
  const principal = await authenticate(c);
  c.set("principal", principal);
  setActiveSpanAttributes({
    "auth.principal.kind": principal.kind,
    "auth.source": c.get("authSource"),
  });
  logger.debug("request principal resolved", {
    authSource: c.get("authSource"),
    principalKind: principal.kind,
  });
  await next();
});

app.use("*", rejectCrossOriginSessionWrites);

app.onError((err, c) => {
  if (err instanceof RegistryError) {
    const meta = { status: err.status, code: err.code, path: new URL(c.req.url).pathname };
    if (err.status >= 500) {
      logger.error("registry error response", meta);
    } else {
      logger.debug("registry error response", meta);
    }
    return err.toResponse();
  }
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
