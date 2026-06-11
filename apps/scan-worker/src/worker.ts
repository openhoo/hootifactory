import { env } from "@hootifactory/config";
import { initializeObservability, logger } from "@hootifactory/observability";
import {
  createMaintenanceScheduler as defaultCreateMaintenanceScheduler,
  installShutdownHandlers as defaultInstallShutdownHandlers,
  startHealthServer as defaultStartHealthServer,
} from "@hootifactory/queue";
import { loadConfiguredRegistryPlugins } from "@hootifactory/registry-runtime";
import { loadConfiguredScanners } from "@hootifactory/scanner-runtime";
import { scannerRuntimeFromEnv as defaultScannerRuntimeFromEnv } from "./pipeline";
import {
  reapExpiredUploads as defaultReapExpiredUploads,
  reclaimStuckScans as defaultReclaimStuckScans,
  runScanCycle as defaultRunScanCycle,
  sweepBlobs as defaultSweepBlobs,
  type ScanWorkerConfig,
} from "./worker-loop";

const workerRole = "scan-worker";

/**
 * Loop collaborators, all defaulting to the real `./pipeline` / `./worker-loop` /
 * `@hootifactory/queue` implementations so production behavior is unchanged. The
 * unit test injects fakes here instead of mutating the process-global module
 * registry with `mock.module`, which leaked into the sibling pipeline/worker-loop
 * suites and made them flaky.
 */
export interface ScanWorkerDeps {
  scannerRuntimeFromEnv?: typeof defaultScannerRuntimeFromEnv;
  reapExpiredUploads?: typeof defaultReapExpiredUploads;
  sweepBlobs?: typeof defaultSweepBlobs;
  reclaimStuckScans?: typeof defaultReclaimStuckScans;
  runScanCycle?: typeof defaultRunScanCycle;
  startHealthServer?: typeof defaultStartHealthServer;
  installShutdownHandlers?: typeof defaultInstallShutdownHandlers;
  createMaintenanceScheduler?: typeof defaultCreateMaintenanceScheduler;
  /**
   * Override for the shutdown drain grace period. Production derives it from
   * SCANNER_TIMEOUT_MS (see runScanWorker); tests inject a small value so the
   * expiry path doesn't take minutes to exercise.
   */
  shutdownGraceMs?: number;
}

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
export async function runScanWorker(deps: ScanWorkerDeps = {}): Promise<void> {
  const scannerRuntimeFromEnv = deps.scannerRuntimeFromEnv ?? defaultScannerRuntimeFromEnv;
  const reapExpiredUploads = deps.reapExpiredUploads ?? defaultReapExpiredUploads;
  const sweepBlobs = deps.sweepBlobs ?? defaultSweepBlobs;
  const reclaimStuckScans = deps.reclaimStuckScans ?? defaultReclaimStuckScans;
  const runScanCycle = deps.runScanCycle ?? defaultRunScanCycle;
  const startHealthServer = deps.startHealthServer ?? defaultStartHealthServer;
  const installShutdownHandlers = deps.installShutdownHandlers ?? defaultInstallShutdownHandlers;
  const createMaintenanceScheduler =
    deps.createMaintenanceScheduler ?? defaultCreateMaintenanceScheduler;

  initializeObservability({ serviceRole: workerRole });
  loadConfiguredRegistryPlugins();
  const loadedScanners = loadConfiguredScanners();
  if (loadedScanners.unknown.length > 0) {
    logger.warn("ignoring unknown scanners in SCANNERS", { unknown: loadedScanners.unknown });
  }

  const workerBatchSize = env.SCAN_WORKER_BATCH_SIZE;
  const workerConcurrency = Math.min(workerBatchSize, env.SCAN_WORKER_CONCURRENCY);
  const pollingIntervalSeconds = env.SCAN_WORKER_POLL_INTERVAL_SECONDS;
  const maxAttempts = env.SCAN_WORKER_MAX_ATTEMPTS;
  const uploadReaperIntervalSeconds = env.UPLOAD_REAPER_INTERVAL_SECONDS;
  const uploadReaperBatchSize = env.UPLOAD_REAPER_BATCH_SIZE;
  const blobGcIntervalSeconds = env.BLOB_GC_INTERVAL_SECONDS;
  const blobGcBatchSize = env.BLOB_GC_BATCH_SIZE;
  const blobGcGraceSeconds = env.BLOB_GC_GRACE_SECONDS;
  // A claimed row whose worker died never reaches markSucceeded/markFailed and is
  // stranded in 'processing', permanently blocking its artifact under enforce-mode
  // policy. Reclaim such rows once they exceed a generous multiple of the worst-
  // case per-artifact scan time (manifest-graph traversal + OSV, each bounded by
  // SCANNER_TIMEOUT_MS, default 120s) so a live worker is never reclaimed mid-scan.
  const scanReclaimIntervalSeconds = env.SCAN_RECLAIM_INTERVAL_SECONDS;
  const scanReclaimTimeoutSeconds = env.SCAN_RECLAIM_TIMEOUT_SECONDS;

  // Shutdown drain grace (#317): exiting mid-cycle strands every claimed
  // scan_outbox row in 'processing' until reclaimStuckScans fires after
  // SCAN_RECLAIM_TIMEOUT_SECONDS (default 900s), gating enforce-mode downloads
  // for up to batchSize artifacts on every deploy. So cleanup drains the
  // in-flight loop iteration, bounded by this grace period: the longest single
  // await inside a cycle is one scanner pass, capped by SCANNER_TIMEOUT_MS
  // (default 120s), and a shutdown typically interrupts at most one pass
  // mid-flight, after which only fast DB row updates remain. The margin covers
  // those non-scanner awaits (claim/mark writes, maintenance.runDue). Derived
  // from existing config instead of a new env var; a pathological batch can
  // still exceed it (~batchSize/concurrency sequential waves), in which case we
  // log, exit, and leave reclaimStuckScans as the backstop for the remainder.
  const shutdownGraceMs = deps.shutdownGraceMs ?? env.SCANNER_TIMEOUT_MS + 30_000;

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

  // The in-flight loop iteration, drained by cleanup. Starts settled so a
  // shutdown that fires before the first iteration doesn't wait on anything.
  let inFlight: Promise<void> = Promise.resolve();

  // This worker runs its own claim/process loop (not pg-boss), so it can't use
  // runWorker, but the readiness endpoint and signal/shutdown lifecycle are shared.
  const health = startHealthServer(workerRole);
  const lifecycle = installShutdownHandlers({
    logLabel: "scan worker",
    cleanup: async () => {
      health.setReady(false);
      await health.server?.stop();
      // Drain the in-flight iteration so claimed rows reach markSucceeded /
      // markFailed instead of being stranded (see shutdownGraceMs above). The
      // race keeps installShutdownHandlers' once-only cleanup bounded — it must
      // never hang the SIGTERM handler — and awaiting an already-settled
      // promise is a no-op, so this stays idempotent. A rejected cycle counts
      // as settled here: its error already propagates through the loop's own
      // await, and shutdown must not be derailed by it.
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        inFlight.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), shutdownGraceMs);
        }),
      ]);
      clearTimeout(graceTimer);
      if (!drained) {
        logger.warn("scan worker shutdown grace period expired with a scan cycle in flight", {
          shutdownGraceMs,
          scanReclaimTimeoutSeconds,
        });
      }
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
    shutdownGraceMs,
    workerPort: env.WORKER_PORT,
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
    // Assigned synchronously after the isShuttingDown() check, so cleanup —
    // which can only start after the flag flips, and the flag can only flip
    // between iterations — always observes the latest iteration's promise.
    inFlight = (async () => {
      await maintenance.runDue();
      await runScanCycle(config, scannerRuntime);
    })();
    await inFlight;
  }
}

// Auto-start only when run as the process entrypoint. Under `bun test` the file is
// imported (not the main module), so the unit test can drive a single, deterministic
// loop iteration by calling runScanWorker() directly with injected collaborators —
// without the import-time loop racing the test's setup.
if (import.meta.main) {
  await runScanWorker();
}
