import { db, eq, scanOutbox, sql } from "@hootifactory/db";
import {
  initializeObservability,
  instrumentHttpRequest,
  logger,
  shutdownObservability,
  withSpan,
} from "@hootifactory/observability";
import { intEnv } from "@hootifactory/queue";
import { reapExpiredOciUploadSessions } from "@hootifactory/registry-application";
import { processScan, recordScanFailure, scannerRuntimeFromEnv } from "./pipeline";

const workerRole = "scan-worker";

initializeObservability({ serviceRole: workerRole });

interface ClaimedScanIntent {
  id: string;
  artifactId: string;
  attempts: number;
}

const workerBatchSize = intEnv("SCAN_WORKER_BATCH_SIZE", 16, 1);
const pollingIntervalSeconds = intEnv("SCAN_WORKER_POLL_INTERVAL_SECONDS", 0.5, 0.5);
const maxAttempts = intEnv("SCAN_WORKER_MAX_ATTEMPTS", 5, 1);
const uploadReaperIntervalSeconds = intEnv("OCI_UPLOAD_REAPER_INTERVAL_SECONDS", 300, 1);
const uploadReaperBatchSize = intEnv("OCI_UPLOAD_REAPER_BATCH_SIZE", 100, 1);

const scannerRuntime = scannerRuntimeFromEnv();

function rowsFromExecute(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function claimedRow(row: unknown): ClaimedScanIntent | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const artifactId =
    typeof r.artifactId === "string"
      ? r.artifactId
      : typeof r.artifact_id === "string"
        ? r.artifact_id
        : null;
  const attempts = typeof r.attempts === "number" ? r.attempts : Number(r.attempts);
  if (!id || !artifactId || !Number.isFinite(attempts)) return null;
  return { id, artifactId, attempts };
}

async function claimScanIntents(limit: number): Promise<ClaimedScanIntent[]> {
  const result = await db.execute(sql`
    with claimed as (
      select id
      from scan_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc, created_at asc
      limit ${limit}
      for update skip locked
    )
    update scan_outbox so
       set status = 'processing',
           attempts = so.attempts + 1,
           locked_at = now(),
           updated_at = now()
      from claimed
     where so.id = claimed.id
    returning so.id, so.artifact_id as "artifactId", so.attempts
  `);
  return rowsFromExecute(result).flatMap((row) => {
    const claimed = claimedRow(row);
    return claimed ? [claimed] : [];
  });
}

async function markSucceeded(intentId: string): Promise<void> {
  await db
    .update(scanOutbox)
    .set({ status: "succeeded", lockedAt: null, lastError: null, updatedAt: new Date() })
    .where(eq(scanOutbox.id, intentId));
}

async function markFailed(intent: ClaimedScanIntent, err: unknown): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  const retry = intent.attempts < maxAttempts;
  await db
    .update(scanOutbox)
    .set({
      status: retry ? "pending" : "failed",
      lockedAt: null,
      lastError: error.slice(0, 2000),
      nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** intent.attempts)),
      updatedAt: new Date(),
    })
    .where(eq(scanOutbox.id, intent.id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let ready = false;
let healthServer: ReturnType<typeof Bun.serve> | null = null;
if (process.env.WORKER_PORT) {
  healthServer = Bun.serve({
    port: Number(process.env.WORKER_PORT),
    hostname: "127.0.0.1",
    fetch: (request) =>
      instrumentHttpRequest(request, async (telemetry) => {
        telemetry.setRoute("/worker/healthz");
        telemetry.setAttribute("worker.role", workerRole);
        telemetry.setAttribute("worker.ready", ready);
        const response = ready ? new Response("ok") : new Response("starting", { status: 503 });
        telemetry.setStatusCode(response.status);
        return response;
      }),
  });
}

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0, reason?: unknown): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (exitCode === 0) {
    logger.info("scan worker shutting down", { signal });
  } else {
    logger.error("scan worker shutting down after fatal error", { signal, error: reason });
  }
  try {
    ready = false;
    await healthServer?.stop();
  } catch (err) {
    exitCode = 1;
    logger.error("scan worker shutdown error", { signal, error: err });
  } finally {
    await shutdownObservability();
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => void shutdown("uncaughtException", 1, err));
process.on("unhandledRejection", (reason) => void shutdown("unhandledRejection", 1, reason));

logger.info("scan worker starting", {
  batchSize: workerBatchSize,
  pollingIntervalSeconds,
  maxAttempts,
  uploadReaperBatchSize,
  uploadReaperIntervalSeconds,
  workerPort: process.env.WORKER_PORT,
  externalScanners: scannerRuntime.scanners,
});
ready = true;

let nextUploadReapAt = 0;

async function reapExpiredUploadsIfDue(): Promise<void> {
  const now = Date.now();
  if (now < nextUploadReapAt) return;
  nextUploadReapAt = now + uploadReaperIntervalSeconds * 1000;
  try {
    const result = await withSpan(
      "oci.upload_sessions.reap_expired",
      { "oci.upload_reaper.batch_size": uploadReaperBatchSize },
      () => reapExpiredOciUploadSessions({ limit: uploadReaperBatchSize }),
    );
    if (result.aborted > 0) {
      logger.info("expired OCI upload sessions reaped", { aborted: result.aborted });
    }
  } catch (err) {
    logger.error("expired OCI upload session reaper failed", { error: err });
  }
}

while (!shuttingDown) {
  await reapExpiredUploadsIfDue();
  const intents = await withSpan(
    "scan.outbox.claim",
    { "worker.batch_size": workerBatchSize },
    () => claimScanIntents(workerBatchSize),
  );
  if (intents.length === 0) {
    await sleep(pollingIntervalSeconds * 1000);
    continue;
  }
  for (const intent of intents) {
    await withSpan(
      "scan.outbox.process",
      {
        "scan.outbox.id": intent.id,
        "artifact.id": intent.artifactId,
        "scan.outbox.attempts": intent.attempts,
      },
      async () => {
        try {
          await processScan(intent.artifactId, scannerRuntime);
          await markSucceeded(intent.id);
        } catch (err) {
          logger.error("scan job failed", {
            artifactId: intent.artifactId,
            attempt: intent.attempts,
            error: err,
          });
          await recordScanFailure(intent.artifactId, err).catch((recordErr) => {
            logger.error("scan failure recording failed", {
              artifactId: intent.artifactId,
              originalError: err instanceof Error ? err.message : String(err),
              error: recordErr,
            });
          });
          await markFailed(intent, err);
        }
      },
    );
  }
}
