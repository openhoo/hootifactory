import { db, sql } from "@hootifactory/db";
import { logger, withSpan } from "@hootifactory/observability";
import { getBoss, QUEUES } from "@hootifactory/queue";
import { blobStore } from "@hootifactory/storage";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const healthRouter = new Hono<AppEnv>();

healthRouter.get("/healthz", (c) => c.json({ status: "ok", service: "hootifactory" }));

async function checkDependency(name: string, check: () => Promise<void>) {
  return withSpan("health.dependency_check", { "health.dependency": name }, async (span) => {
    try {
      await check();
      span.setAttribute("health.dependency.ok", true);
      logger.debug("readiness dependency ok", { dependency: name });
      return { name, ok: true as const };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      span.setAttributes({ "health.dependency.ok": false, "error.message": error });
      logger.warn("readiness dependency failed", { dependency: name, error });
      return {
        name,
        ok: false as const,
        error,
      };
    }
  });
}

healthRouter.get("/readyz", async (c) => {
  const checks = await Promise.all([
    checkDependency("db", async () => {
      await db.execute(sql`select 1`);
    }),
    checkDependency("storage", async () => {
      await blobStore.statKey("__hootifactory/readyz");
    }),
    checkDependency("queue", async () => {
      const boss = await getBoss();
      const queues = await Promise.all(Object.values(QUEUES).map((q) => boss.getQueue(q)));
      if (queues.some((q) => !q)) throw new Error("one or more queues are missing");
    }),
  ]);
  const ready = checks.every((check) => check.ok);
  logger.debug("readiness check completed", {
    ready,
    failed: checks.filter((check) => !check.ok).map((check) => check.name),
  });
  if (ready) {
    return c.json({ status: "ready", checks });
  }
  return c.json({ status: "not-ready", checks }, 503);
});
