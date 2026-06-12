import { mapWithBoundedConcurrency } from "@hootifactory/core";
import { and, db, eq, scanOutbox, sql } from "@hootifactory/db";
import { logger, withSpan, withTelemetryContext } from "@hootifactory/observability";
import {
  reapExpiredContentUploadSessions,
  sweepUnreferencedCasBlobs,
} from "@hootifactory/registry-platform/content";
import { applyDueRetentionPolicies } from "@hootifactory/registry-platform/repositories";
import { SCAN_OUTBOX_STATUS } from "@hootifactory/scan-core";
import type { ScannerRuntime } from "@hootifactory/scanner";
import { processScan, recordScanFailure } from "./pipeline";
import {
  type ClaimedScanIntent,
  claimedAttemptFilter,
  claimedScanIntentsFromExecute,
} from "./scan-outbox-rows";

/**
 * Backend seams for the claim/process loop, all defaulting to the real
 * `@hootifactory/db` `db` and `./pipeline` helpers so production behavior is
 * unchanged. Tests inject fakes so no function ever opens a real connection.
 */
export interface ScanLoopDeps {
  db?: typeof db;
  processScan?: typeof processScan;
  recordScanFailure?: typeof recordScanFailure;
  withTelemetryContext?: typeof withTelemetryContext;
}

/** Tunables for the scan-worker claim/process loop and its maintenance sweeps. */
export interface ScanWorkerConfig {
  batchSize: number;
  concurrency: number;
  pollingIntervalSeconds: number;
  maxAttempts: number;
  uploadReaperBatchSize: number;
  uploadReaperIntervalSeconds: number;
  blobGcBatchSize: number;
  blobGcGraceSeconds: number;
  blobGcIntervalSeconds: number;
  scanReclaimIntervalSeconds: number;
  scanReclaimTimeoutSeconds: number;
  retentionApplyBatchSize: number;
  retentionApplyIntervalSeconds: number;
}

/**
 * Claim up to `limit` pending scan_outbox rows in one atomic UPDATE...FOR UPDATE
 * SKIP LOCKED, stamping each with an incremented attempts count that doubles as the
 * optimistic-concurrency token for the terminal write.
 */
export async function claimScanIntents(
  limit: number,
  dbClient: typeof db = db,
): Promise<ClaimedScanIntent[]> {
  const result = await dbClient.execute(sql`
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
    returning so.id, so.artifact_id as "artifactId", so.attempts, so.telemetry
  `);
  return claimedScanIntentsFromExecute(result);
}

/**
 * Start a periodic heartbeat that refreshes locked_at on the claimed row so
 * reclaimStuckScans does not reclaim a live, long-running scan. Returns a stop
 * function (call to cancel the interval).
 *
 * Uses claimedAttemptFilter: if a reclaim or another worker picks up the row, the
 * filter no longer matches and the heartbeat UPDATE becomes a no-op.
 */
export function startLockHeartbeat(
  intent: ClaimedScanIntent,
  intervalMs: number,
  dbClient: typeof db = db,
): () => void {
  const timer = setInterval(() => {
    dbClient
      .update(scanOutbox)
      .set({ lockedAt: new Date(), updatedAt: new Date() })
      .where(claimedAttemptFilter(intent))
      .execute()
      .catch(() => {
        // Heartbeat failures are benign: if the DB is temporarily unreachable the
        // next tick will retry; if the row was reclaimed, the filter no longer
        // matches and the update is a no-op.
      });
  }, intervalMs);
  return () => clearInterval(timer);
}

// Terminal writes are gated by claimedAttemptFilter (optimistic concurrency): a
// worker finalizes only the exact attempt it claimed. If a re-publish reset the row
// to 'pending' and another worker re-claimed it (advancing attempts), or a reclaim
// moved it out of 'processing', the filter no longer matches, the UPDATE is a no-op,
// and a stale worker cannot clobber the newer attempt or a re-requested rescan.
export async function markSucceeded(
  intent: ClaimedScanIntent,
  dbClient: typeof db = db,
): Promise<void> {
  await dbClient
    .update(scanOutbox)
    .set({
      status: SCAN_OUTBOX_STATUS.succeeded,
      lockedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(claimedAttemptFilter(intent));
}

export async function markFailed(
  intent: ClaimedScanIntent,
  err: unknown,
  maxAttempts: number,
  dbClient: typeof db = db,
): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  const retry = intent.attempts < maxAttempts;
  await dbClient
    .update(scanOutbox)
    .set({
      status: retry ? SCAN_OUTBOX_STATUS.pending : SCAN_OUTBOX_STATUS.failed,
      lockedAt: null,
      lastError: error.slice(0, 2000),
      nextAttemptAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** intent.attempts)),
      updatedAt: new Date(),
    })
    .where(claimedAttemptFilter(intent));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reapExpiredUploads(batchSize: number): Promise<void> {
  try {
    const result = await withSpan(
      "upload_sessions.reap_expired",
      { "upload_reaper.batch_size": batchSize },
      () => reapExpiredContentUploadSessions({ limit: batchSize }),
    );
    if (result.aborted > 0 || result.cleaned > 0) {
      logger.info("expired upload sessions reaped", {
        aborted: result.aborted,
        cleaned: result.cleaned,
      });
    }
  } catch (err) {
    logger.error("expired upload session reaper failed", { error: err });
  }
}

export async function sweepBlobs(batchSize: number, graceSeconds: number): Promise<void> {
  try {
    const result = await withSpan(
      "blob_gc.sweep",
      {
        "blob_gc.batch_size": batchSize,
        "blob_gc.grace_seconds": graceSeconds,
      },
      () =>
        sweepUnreferencedCasBlobs({
          limit: batchSize,
          graceMs: graceSeconds * 1000,
        }),
    );
    if (result.candidates > 0 || result.reclaimed > 0) {
      logger.info("unreferenced CAS blobs swept", result);
    }
  } catch (err) {
    logger.error("unreferenced CAS blob sweeper failed", { error: err });
  }
}

/**
 * Apply persisted per-repository retention policies on the maintenance cadence
 * (#323). The sweep itself isolates failures per repository; this wrapper only
 * adds the span + structured logging and absorbs a whole-sweep failure (e.g. the
 * policy query itself) so the maintenance scheduler never aborts the loop.
 */
export async function applyRetentionPolicies(
  batchSize: number,
  sweep: typeof applyDueRetentionPolicies = applyDueRetentionPolicies,
): Promise<void> {
  try {
    const result = await withSpan("retention.apply", { "retention.batch_size": batchSize }, () =>
      sweep({ limit: batchSize }),
    );
    if (result.policies > 0) {
      logger.info("scheduled retention sweep completed", result);
    }
  } catch (err) {
    logger.error("scheduled retention sweep failed", { error: err });
  }
}

export async function reclaimStuckScans(
  timeoutSeconds: number,
  maxAttempts: number,
  dbClient: typeof db = db,
): Promise<void> {
  try {
    const reclaimed = await withSpan(
      "scan.outbox.reclaim_stuck",
      { "scan.reclaim.timeout_seconds": timeoutSeconds },
      () =>
        dbClient
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
              sql`${scanOutbox.lockedAt} < now() - make_interval(secs => ${timeoutSeconds})`,
            ),
          )
          .returning({ id: scanOutbox.id }),
    );
    if (reclaimed.length > 0) {
      logger.warn("reclaimed stuck scan_outbox rows", {
        reclaimed: reclaimed.length,
        timeoutSeconds,
      });
    }
  } catch (err) {
    logger.error("stuck scan reclaim failed", { error: err });
  }
}

/**
 * Process one claimed intent: run the scan pipeline then finalize the row.
 *
 * The per-artifact span runs inside the telemetry context stamped on the row at
 * publish time (issue #341), so scan.outbox.process parents to the publish trace
 * exactly the way instrumentQueueJob links pg-boss email jobs to their enqueue.
 */
export async function processClaimedIntent(
  intent: ClaimedScanIntent,
  scannerRuntime: ScannerRuntime,
  maxAttempts: number,
  deps: ScanLoopDeps = {},
  heartbeatMs?: number,
): Promise<void> {
  const dbClient = deps.db ?? db;
  const runScan = deps.processScan ?? processScan;
  const recordFailure = deps.recordScanFailure ?? recordScanFailure;
  const restoreTelemetry = deps.withTelemetryContext ?? withTelemetryContext;
  const stopHeartbeat = heartbeatMs ? startLockHeartbeat(intent, heartbeatMs, dbClient) : () => {};
  try {
    return restoreTelemetry(intent.telemetry, () =>
      withSpan(
        "scan.outbox.process",
        {
          "scan.outbox.id": intent.id,
          "artifact.id": intent.artifactId,
          "scan.outbox.attempts": intent.attempts,
        },
        async () => {
          let scanError: unknown = null;
          try {
            await runScan(intent.artifactId, scannerRuntime);
          } catch (err) {
            scanError = err;
            logger.error("scan job failed", {
              artifactId: intent.artifactId,
              attempt: intent.attempts,
              error: err,
            });
            await recordFailure(intent.artifactId, err).catch((recordErr) => {
              logger.error("scan failure recording failed", {
                artifactId: intent.artifactId,
                originalError: err instanceof Error ? err.message : String(err),
                error: recordErr,
              });
            });
          }

          try {
            if (scanError) {
              await markFailed(intent, scanError, maxAttempts, dbClient);
            } else {
              await markSucceeded(intent, dbClient);
            }
          } catch (dbErr) {
            logger.error("failed to finalize scan intent", {
              "scan.outbox.id": intent.id,
              "artifact.id": intent.artifactId,
              error: dbErr,
            });
          }
        },
      ),
    );
  } finally {
    stopHeartbeat();
  }
}

/** Run one claim/process cycle: claim a batch and fan it out over the scanners. */
export async function runScanCycle(
  config: ScanWorkerConfig,
  scannerRuntime: ScannerRuntime,
  deps: ScanLoopDeps = {},
): Promise<number> {
  const dbClient = deps.db ?? db;
  try {
    const intents = await withSpan(
      "scan.outbox.claim",
      { "worker.batch_size": config.batchSize },
      () => claimScanIntents(config.batchSize, dbClient),
    );
    if (intents.length === 0) {
      await sleep(config.pollingIntervalSeconds * 1000);
      return 0;
    }
    const heartbeatMs = Math.max(
      10_000,
      Math.min(30_000, (config.scanReclaimTimeoutSeconds * 1000) / 10),
    );
    await mapWithBoundedConcurrency(intents, config.concurrency, (intent) =>
      processClaimedIntent(intent, scannerRuntime, config.maxAttempts, deps, heartbeatMs),
    );
    return intents.length;
  } catch (err) {
    logger.error("scan cycle failed", { error: err });
    await sleep(config.pollingIntervalSeconds * 1000);
    return 0;
  }
}
