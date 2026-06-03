import { checkReadiness } from "@hootifactory/registry-application";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const healthRouter = new Hono<AppEnv>();

healthRouter.get("/healthz", (c) => c.json({ status: "ok", service: "hootifactory" }));

healthRouter.get("/readyz", async (c) => {
  const { ready, checks } = await checkReadiness();
  if (ready) {
    return c.json({ status: "ready", checks });
  }
  return c.json({ status: "not-ready", checks }, 503);
});
