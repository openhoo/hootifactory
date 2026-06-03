import type { ReadinessDependencyCheck } from "@hootifactory/registry-application";
import { checkReadiness } from "@hootifactory/registry-application";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const healthRouter = new Hono<AppEnv>();

export function publicReadinessChecks(
  checks: ReadinessDependencyCheck[],
): ReadinessDependencyCheck[] {
  return checks.map(({ name, ok }) => ({ name, ok }));
}

healthRouter.get("/healthz", (c) => c.json({ status: "ok", service: "hootifactory" }));

healthRouter.get("/readyz", async (c) => {
  const { ready, checks } = await checkReadiness();
  const publicChecks = publicReadinessChecks(checks);
  if (ready) {
    return c.json({ status: "ready", checks: publicChecks });
  }
  return c.json({ status: "not-ready", checks: publicChecks }, 503);
});
