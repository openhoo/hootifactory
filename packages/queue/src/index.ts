import { env } from "@hootifactory/config";
import { logger, withSpan } from "@hootifactory/observability";
import { type Job, PgBoss, type SendOptions, type WorkOptions } from "pg-boss";

/**
 * Durable pg-boss queues. Rule of thumb: pg-boss carries fire-and-forget delivery
 * jobs only. Work that must stay transactionally consistent with registry writes
 * (scan scheduling, blob GC, retention) runs through DB-backed outbox/maintenance
 * loops instead, so it commits or rolls back with the write that produced it.
 */
export const QUEUES = {
  emailSend: "email.send",
} as const;

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

/** Construct the pg-boss instance from env. Overridable in tests via {@link getBoss}. */
export type BossFactory = () => PgBoss;

const defaultBossFactory: BossFactory = () =>
  new PgBoss({
    connectionString: env.DATABASE_URL,
    max: env.PG_BOSS_POOL_MAX,
  });

/**
 * Lazily start a shared pg-boss instance and ensure all queues exist.
 *
 * `factory` is an injection seam (defaults to the env-configured pg-boss) so the
 * lifecycle can be tested with a fake boss; production callers pass nothing.
 */
export async function getBoss(factory: BossFactory = defaultBossFactory): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  if (!startPromise) {
    const starting = (async () => {
      const boss = factory();
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
    startPromise = starting;
    // A failed start must not poison the singleton: clear the cached promise so
    // the next caller constructs a fresh boss and retries, instead of replaying
    // the same rejection until the process restarts. (bossInstance is only set
    // on success above, so it never holds a half-started boss.)
    starting.catch(() => {
      if (startPromise === starting) startPromise = null;
    });
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

/**
 * Mark jobs completed ahead of their batch handler resolving. pg-boss only
 * fails jobs still below the `completed` state when a batch handler rejects,
 * so acking each finished job here lets a worker rethrow for the failed
 * remainder without re-delivering the siblings that already succeeded.
 */
export async function completeJobs(queue: string, ids: string[]): Promise<void> {
  const boss = await getBoss();
  await withSpan("queue.complete", { "messaging.destination.name": queue }, async () => {
    await boss.complete(queue, ids);
  });
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

export {
  createMaintenanceScheduler,
  type MaintenanceScheduler,
  type MaintenanceTask,
} from "./maintenance";
export {
  type HealthServer,
  installShutdownHandlers,
  type RunWorkerConfig,
  runWorker,
  type ShutdownController,
  startHealthServer,
} from "./runtime";
export type { PgBoss };
