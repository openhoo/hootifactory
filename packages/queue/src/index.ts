import { env } from "@hootifactory/config";
import { logger, withSpan } from "@hootifactory/observability";
import { type Job, PgBoss, type SendOptions, type WorkOptions } from "pg-boss";

export const QUEUES = {
  scanArtifact: "scan.artifact",
  gcSweep: "gc.sweep",
  retentionApply: "retention.apply",
  emailSend: "email.send",
} as const;

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

/** Lazily start a shared pg-boss instance and ensure all queues exist. */
export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  if (!startPromise) {
    startPromise = (async () => {
      const boss = new PgBoss({
        connectionString: env.DATABASE_URL,
        max: env.PG_BOSS_POOL_MAX,
      });
      boss.on("error", (err) => logger.error("pg-boss error", { error: err }));
      await withSpan("queue.start", {}, async () => {
        await boss.start();
        for (const q of Object.values(QUEUES)) {
          await withSpan("queue.ensure", { "messaging.destination.name": q }, () =>
            boss.createQueue(q),
          );
        }
      });
      bossInstance = boss;
      return boss;
    })();
  }
  return startPromise;
}

export async function enqueue<T extends object>(
  queue: string,
  data: T,
  options: SendOptions = {},
): Promise<string | null> {
  const boss = await getBoss();
  return withSpan("queue.enqueue", { "messaging.destination.name": queue }, () =>
    boss.send(queue, data, options),
  );
}

export type JobHandler<T extends object> = (jobs: Job<T>[]) => Promise<void>;

export async function work<T extends object>(
  queue: string,
  handler: JobHandler<T>,
  options: WorkOptions = {},
): Promise<string> {
  const boss = await getBoss();
  return withSpan("queue.register_worker", { "messaging.destination.name": queue }, () =>
    boss.work<T>(queue, options, handler),
  );
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await withSpan("queue.stop", {}, () => bossInstance?.stop() ?? Promise.resolve());
    bossInstance = null;
    startPromise = null;
  }
}

export { intEnv, type RunWorkerConfig, runWorker } from "./runtime";
export type { PgBoss };
