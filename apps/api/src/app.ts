import { RegistryError } from "@hootifactory/core";
import { Hono } from "hono";
import { logger } from "./lib/logger";
import { authenticate } from "./middleware/authenticate";
import { handleRegistryRequest } from "./registry";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { uiRouter } from "./routes/ui";
import { v2VersionCheck } from "./routes/v2";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>();

// Identity for every request (defaults to anonymous).
app.use("*", async (c, next) => {
  c.set("principal", await authenticate(c));
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

// OCI version check — exact paths only; deeper /v2/<name>/... falls through.
app.get("/v2", v2VersionCheck);
app.get("/v2/", v2VersionCheck);

// Everything else is registry traffic.
app.all("*", (c) => handleRegistryRequest(c));
