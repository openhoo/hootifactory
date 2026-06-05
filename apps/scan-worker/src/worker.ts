import { mapWithBoundedConcurrency } from "@hootifactory/core";
import { and, db, eq, scanOutbox, sql } from "@hootifactory/db";
import { initializeObservability, logger, withSpan } from "@hootifactory/observability";
import {
  createMaintenanceScheduler,
  installShutdownHandlers,
  intEnv,
  startHealthServer,
} from "@hootifactory/queue";
import {
  reapExpiredContentUploadSessions,
  sweepUnreferencedCasBlobs,
} from "@hootifactory/registry-application/content";
import { registerBuiltInRegistryPlugins } from "@hootifactory/registry-builtins";
import { SCAN_OUTBOX_STATUS } from "@hootifactory/scan-core";
import { processScan, recordScanFailure, scannerRuntimeFromEnv } from "./pipeline";
import { type ClaimedScanIntent, claimedScanIntentsFromExecute } from "./scan-outbox-rows";

const workerRole = "scan-worker";

initializeObservability({ serviceRole: workerRole });
registerBuiltInRegistryPlugins();

const workerBatchSize = intEnv("SCAN_WORKER_BATCH_SIZE", 16, 1);
const workerConcurrency = Math.min(workerBatchSize, intEnv("SCAN_WORKER_CONCURRENCY", 4, 1));
const pollingIntervalSeconds = intEnv("SCAN_WORKER_POLL_INTERVAL_SECONDS", 0.5, 0.5);
const maxAttempts = intEnv("SCAN_WORKER_MAX_ATTEMPTS", 5, 1);
const uploadReaperIntervalSeconds = intEnv("UPLOAD_REAPER_INTERVAL_SECONDS", 300, 1);
const uploadReaperBatchSize = intEnv("UPLOAD_REAPER_BATCH_SIZE", 100, 1);
const blobGcIntervalSeconds = intEnv("BLOB_GC_INTERVAL_SECONDS", 300, 1);
const blobGcBatchSize = intEnv("BLOB_GC_BATCH_SIZE", 100, 1);
const blobGcGraceSeconds = intEnv("BLOB_GC_GRACE_SECONDS", 60, 0);
// A claimed row whose worker died never reaches markSucceeded/markFailed and is
// stranded in 'processing', permanently blocking its artifact under enforce-mode
// policy. Reclaim such rows once they exceed a generous multiple of the worst-
// case per-artifact scan time (manifest-graph traversal + OSV, each bounded by
// SCANNER_TIMEOUT_MS, default 120s) so a live worker is never reclaimed mid-scan.
const scanReclaimIntervalSeconds = intEnv("SCAN_RECLAIM_INTERVAL_SECONDS", 300, 1);
const scanReclaimTimeoutSeconds = intEnv("SCAN_RECLAIM_TIMEOUT_SECONDS", 900, 60);

const scannerRuntime = scannerRuntimeFromEnv();

async function claimScanIntents(limit: number): Promise<ClaimedScanIntent[]> {
  const result = await db.execute(sql`
    with claimed as (
      select id
      from scan_outbox
      where status = ${SCAN_OUTBOX_STATUS.pending} and next_attempt_at <= now()
      order by next_attempt_at asc, created_at asc
      limit ${limit}
      for update skip locked
    )
    update scan_outbox so
       set status = ${SCAN_OUTBOX_STATUS.processing},
           attempts = so.attempts + 1,
           locked_at = now(),
           updated_at = now()
      from claimed
     where so.id = claimed.id
    returning so.id, so.artifact_id as "artifactId", so.attempts
  `);
  return claimedScanIntentsFromExecute(result);
}

async function markSucceeded(intentId: string): Promise<void> {
  await db
    .update(scanOutbox)
    .set({
      status: SCAN_OUTBOX_STATUS.succeeded,
      lockedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(scanOutbox.id, intentId));
}

async function markFailed(intent: ClaimedScanIntent, err: unknown): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  const retry = intent.attempts < maxAttempts;
  await db
    .update(scanOutbox)
    .set({
      status: retry ? SCAN_OUTBOX_STATUS.pending : SCAN_OUTBOX_STATUS.failed,
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

// This worker runs its own claim/process loop (not pg-boss), so it can't use
// runWorker, but the readiness endpoint and signal/shutdown lifecycle are shared.
const health = startHealthServer(workerRole);
const lifecycle = installShutdownHandlers({
  logLabel: "scan worker",
  cleanup: async () => {
    health.setReady(false);
    await health.server?.stop();
  },
});

logger.info("scan worker starting", {
  batchSize: workerBatchSize,
  concurrency: workerConcurrency,
  pollingIntervalSeconds,
  maxAttempts,
  uploadReaperBatchSize,
  uploadReaperIntervalSeconds,
  blobGcBatchSize,
  blobGcGraceSeconds,
  blobGcIntervalSeconds,
  scanReclaimIntervalSeconds,
  scanReclaimTimeoutSeconds,
  workerPort: process.env.WORKER_PORT,
  externalScanners: scannerRuntime.scanners,
});
health.setReady(true);

async function reapExpiredUploads(): Promise<void> {
  try {
    const result = await withSpan(
      "upload_sessions.reap_expired",
      { "upload_reaper.batch_size": uploadReaperBatchSize },
      () => reapExpiredContentUploadSessions({ limit: uploadReaperBatchSize }),
    );
    if (result.aborted > 0) {
      logger.info("expired upload sessions reaped", { aborted: result.aborted });
    }
  } catch (err) {
    logger.error("expired upload session reaper failed", { error: err });
  }
}

async function sweepBlobs(): Promise<void> {
  try {
    const result = await withSpan(
      "blob_gc.sweep",
      {
        "blob_gc.batch_size": blobGcBatchSize,
        "blob_gc.grace_seconds": blobGcGraceSeconds,
      },
      () =>
        sweepUnreferencedCasBlobs({
          limit: blobGcBatchSize,
          graceMs: blobGcGraceSeconds * 1000,
        }),
    );
    if (result.candidates > 0 || result.reclaimed > 0) {
      logger.info("unreferenced CAS blobs swept", result);
    }
  } catch (err) {
    logger.error("unreferenced CAS blob sweeper failed", { error: err });
  }
}

async function reclaimStuckScans(): Promise<void> {
  try {
    const reclaimed = await withSpan(
      "scan.outbox.reclaim_stuck",
      { "scan.reclaim.timeout_seconds": scanReclaimTimeoutSeconds },
      () =>
        db
          .update(scanOutbox)
          .set({
            // attempts was already incremented at claim time, so mirror markFailed:
            // exhaust to 'failed' once attempts reach the cap, otherwise retry.
            status: sql`case when ${scanOutbox.attempts} >= ${maxAttempts}
                             then ${SCAN_OUTBOX_STATUS.failed}
                             else ${SCAN_OUTBOX_STATUS.pending} end`,
            lockedAt: null,
            nextAttemptAt: new Date(),
            lastError: "reclaimed: worker stopped while processing",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scanOutbox.status, SCAN_OUTBOX_STATUS.processing),
              sql`${scanOutbox.lockedAt} < now() - make_interval(secs => ${scanReclaimTimeoutSeconds})`,
            ),
          )
          .returning({ id: scanOutbox.id }),
    );
    if (reclaimed.length > 0) {
      logger.warn("reclaimed stuck scan_outbox rows", {
        reclaimed: reclaimed.length,
        timeoutSeconds: scanReclaimTimeoutSeconds,
      });
    }
  } catch (err) {
    logger.error("stuck scan reclaim failed", { error: err });
  }
}

const maintenance = createMaintenanceScheduler([
  {
    name: "upload_sessions.reap_expired",
    intervalMs: uploadReaperIntervalSeconds * 1000,
    run: reapExpiredUploads,
  },
  {
    name: "blob_gc.sweep",
    intervalMs: blobGcIntervalSeconds * 1000,
    run: sweepBlobs,
  },
  {
    name: "scan.outbox.reclaim_stuck",
    intervalMs: scanReclaimIntervalSeconds * 1000,
    run: reclaimStuckScans,
  },
]);

while (!lifecycle.isShuttingDown()) {
  await maintenance.runDue();
  const intents = await withSpan(
    "scan.outbox.claim",
    { "worker.batch_size": workerBatchSize },
    () => claimScanIntents(workerBatchSize),
  );
  if (intents.length === 0) {
    await sleep(pollingIntervalSeconds * 1000);
    continue;
  }
  await mapWithBoundedConcurrency(intents, workerConcurrency, async (intent) => {
    return withSpan(
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
  });
}
