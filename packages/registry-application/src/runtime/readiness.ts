import { db, sql } from "@hootifactory/db";
import { logger, withSpan } from "@hootifactory/observability";
import { getBoss, QUEUES } from "@hootifactory/queue";
import { blobStore } from "@hootifactory/storage";

export type ReadinessDependencyCheck =
  | { name: string; ok: true }
  | { name: string; ok: false; error: string };

export interface ReadinessState {
  ready: boolean;
  checks: ReadinessDependencyCheck[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkDependency(
  name: string,
  check: () => Promise<void>,
): Promise<ReadinessDependencyCheck> {
  return withSpan("health.dependency_check", { "health.dependency": name }, async (span) => {
    try {
      await check();
      span.setAttribute("health.dependency.ok", true);
      logger.debug("readiness dependency ok", { dependency: name });
      return { name, ok: true };
    } catch (err) {
      const error = errorText(err);
      span.setAttributes({ "health.dependency.ok": false, "error.message": error });
      logger.warn("readiness dependency failed", { dependency: name, error });
      return { name, ok: false, error };
    }
  });
}

export async function checkReadiness(): Promise<ReadinessState> {
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
  return { ready, checks };
}
