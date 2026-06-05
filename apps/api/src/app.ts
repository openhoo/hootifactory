import { RegistryError } from "@hootifactory/core";
import {
  initializeObservability,
  instrumentHttpRequest,
  setActiveSpanAttributes,
} from "@hootifactory/observability";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { planApplicationErrorResponse } from "./error-response";
import { logger } from "./lib/logger";
import { authenticate } from "./middleware/authenticate";
import {
  enforceRegistryWriteAdmission,
  enforceRequestBodyLimits,
  rejectCrossOriginSessionWrites,
} from "./middleware/request-safety";
import { securityHeaders } from "./middleware/security-headers";
import { handleRegistryRequest } from "./registry";
import { apiV1Router } from "./routes/api-v1";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { uiRouter } from "./routes/ui";
import type { AppEnv } from "./types";

initializeObservability({ serviceRole: "api" });

export const app = new Hono<AppEnv>();

app.use("*", securityHeaders);

app.use("*", async (c, next) => {
  await instrumentHttpRequest(c.req.raw, async (telemetry) => {
    c.set("httpTelemetry", telemetry);
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
app.use("*", enforceRegistryWriteAdmission);

app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  if (err instanceof RegistryError) {
    const meta = { status: err.status, code: err.code, path };
    if (err.status >= 500) {
      logger.error("registry error response", { ...meta, error: err });
    } else {
      logger.debug("registry error response", meta);
    }
    return err.toResponse();
  }
  const plan = planApplicationErrorResponse(err, {
    path,
    requestId: c.get("requestId"),
  });
  const meta = { status: plan.status, code: plan.code, path, error: plan.error };
  if (plan.logLevel === "error") {
    logger.error(plan.logMessage, meta);
  } else {
    logger.warn(plan.logMessage, meta);
  }
  return c.json(plan.body, plan.status as ContentfulStatusCode);
});

// Explicit app routes (evaluated before the registry catch-all).
app.route("/", healthRouter);
app.route("/api/auth", authRouter);
app.route("/api/v1", apiV1Router);
app.route("/api", uiRouter);

// Everything else is registry traffic. Module-owned app-level routes (e.g. the
// OCI /v2 + /token service) are dispatched inside handleRegistryRequest, which
// runs after the built-in plugins have been registered.
app.all("*", (c) => handleRegistryRequest(c));
