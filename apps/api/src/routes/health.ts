import { db, sql } from "@hootifactory/db";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const healthRouter = new Hono<AppEnv>();

healthRouter.get("/healthz", (c) => c.json({ status: "ok", service: "hootifactory" }));

healthRouter.get("/readyz", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ status: "ready" });
  } catch (err) {
    return c.json({ status: "not-ready", error: String(err) }, 503);
  }
});
