import { db, sql } from "@hootifactory/db";
import { getBoss, QUEUES } from "@hootifactory/queue";
import { blobStore } from "@hootifactory/storage";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const healthRouter = new Hono<AppEnv>();

healthRouter.get("/healthz", (c) => c.json({ status: "ok", service: "hootifactory" }));

async function checkDependency(name: string, check: () => Promise<void>) {
  try {
    await check();
    return { name, ok: true as const };
  } catch (err) {
    return {
      name,
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
  if (ready) {
    return c.json({ status: "ready", checks });
  }
  return c.json({ status: "not-ready", checks }, 503);
});
