import { env } from "@hootifactory/config";
import { type Job, PgBoss, type SendOptions, type WorkOptions } from "pg-boss";

export const QUEUES = {
  scanArtifact: "scan.artifact",
  gcSweep: "gc.sweep",
  retentionApply: "retention.apply",
} as const;

let bossInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;

/** Lazily start a shared pg-boss instance and ensure all queues exist. */
export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  if (!startPromise) {
    startPromise = (async () => {
      const boss = new PgBoss(env.DATABASE_URL);
      boss.on("error", (err) => console.error("[pg-boss]", err));
      await boss.start();
      for (const q of Object.values(QUEUES)) {
        await boss.createQueue(q);
      }
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
  return boss.send(queue, data, options);
}

export type JobHandler<T extends object> = (jobs: Job<T>[]) => Promise<void>;

export async function work<T extends object>(
  queue: string,
  handler: JobHandler<T>,
  options: WorkOptions = {},
): Promise<string> {
  const boss = await getBoss();
  return boss.work<T>(queue, options, handler);
}

export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop();
    bossInstance = null;
    startPromise = null;
  }
}

export type { PgBoss };
