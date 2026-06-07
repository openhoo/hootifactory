import { initializeObservability, logger } from "@hootifactory/observability";
import {
  createMaintenanceScheduler,
  installShutdownHandlers,
  intEnv,
  startHealthServer,
} from "@hootifactory/queue";
import { loadConfiguredRegistryPlugins } from "@hootifactory/registry-runtime";
import { loadConfiguredScanners } from "@hootifactory/scanner-runtime";
import { scannerRuntimeFromEnv } from "./pipeline";
import {
  reapExpiredUploads,
  reclaimStuckScans,
  runScanCycle,
  type ScanWorkerConfig,
  sweepBlobs,
} from "./worker-loop";

const workerRole = "scan-worker";

/**
 * Bootstrap and drive the scan-worker: initialize observability + plugins, resolve
 * the loop config, wire the health server / shutdown lifecycle / maintenance
 * scheduler, then run the claim/process loop until shutdown.
 *
 * This is an exported async function (invoked once at module load below) rather
 * than top-level statements so the unit test can drive a single, deterministic loop
 * iteration by calling it directly with collaborators stubbed — top-level
 * import-time side effects do not interleave reliably with `mock.module` under
 * `bun test --isolate`.
 */
export async function runScanWorker(): Promise<void> {
  initializeObservability({ serviceRole: workerRole });
  loadConfiguredRegistryPlugins();
  const loadedScanners = loadConfiguredScanners();
  if (loadedScanners.unknown.length > 0) {
    logger.warn("ignoring unknown scanners in SCANNERS", { unknown: loadedScanners.unknown });
  }

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

  const config: ScanWorkerConfig = {
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
  };

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
    scanners: scannerRuntime.scanners
      .filter((scanner) => scanner.available)
      .map((scanner) => scanner.plugin.id),
  });
  health.setReady(true);

  const maintenance = createMaintenanceScheduler([
    {
      name: "upload_sessions.reap_expired",
      intervalMs: uploadReaperIntervalSeconds * 1000,
      run: () => reapExpiredUploads(uploadReaperBatchSize),
    },
    {
      name: "blob_gc.sweep",
      intervalMs: blobGcIntervalSeconds * 1000,
      run: () => sweepBlobs(blobGcBatchSize, blobGcGraceSeconds),
    },
    {
      name: "scan.outbox.reclaim_stuck",
      intervalMs: scanReclaimIntervalSeconds * 1000,
      run: () => reclaimStuckScans(scanReclaimTimeoutSeconds, maxAttempts),
    },
  ]);

  while (!lifecycle.isShuttingDown()) {
    await maintenance.runDue();
    await runScanCycle(config, scannerRuntime);
  }
}

await runScanWorker();
