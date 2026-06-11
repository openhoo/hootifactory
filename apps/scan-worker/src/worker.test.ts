import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ScannerRuntime } from "@hootifactory/scanner";

/**
 * worker.ts is the thin scan-worker entrypoint: read config, wire the health
 * server + shutdown lifecycle + maintenance scheduler, then drive the claim/process
 * loop from worker-loop.ts. Its auto-start is guarded by import.meta.main, so the
 * test imports the exported runScanWorker and invokes it ONCE with its loop
 * collaborators INJECTED (not via process-global mock.module of ./pipeline /
 * ./worker-loop, which leaked into the sibling suites) and the shutdown controller
 * rigged to permit a single loop iteration. Only the genuinely external boundaries
 * (queue / observability / plugin loaders) are stubbed at the module level. The loop
 * body's real work lives in worker-loop.ts (unit-tested separately); here we only
 * assert the entrypoint wires config + scheduler + cycle correctly.
 *
 * The "shutdown drain" suite below additionally exercises the #317 fix — cleanup
 * must await the in-flight loop iteration (bounded by a grace period) — using
 * ONLY dependency injection: the queue lifecycle collaborators are injected
 * through ScanWorkerDeps, no further mock.module.
 */

interface Captured {
  readyStates: boolean[];
  cleanedUp: boolean;
  unknownWarned: boolean;
  warnings: string[];
  scheduledTasks: string[];
  ranDueCount: number;
  cycleCount: number;
  cycleConfig: unknown;
}

const captured: Captured = {
  readyStates: [],
  cleanedUp: false,
  unknownWarned: false,
  warnings: [],
  scheduledTasks: [],
  ranDueCount: 0,
  cycleCount: 0,
  cycleConfig: null,
};

let iteration = 0;

await (async () => {
  const realObs = await import("@hootifactory/observability");
  await mock.module("@hootifactory/observability", () => ({
    ...realObs,
    initializeObservability: () => {},
    logger: {
      ...realObs.logger,
      info: () => {},
      warn: (msg: string) => {
        captured.warnings.push(msg);
        if (msg.includes("unknown scanners")) captured.unknownWarned = true;
      },
      error: () => {},
    },
  }));

  const realQueue = await import("@hootifactory/queue");
  await mock.module("@hootifactory/queue", () => ({
    ...realQueue,
    startHealthServer: () => ({
      server: { stop: async () => {} },
      setReady: (ready: boolean) => captured.readyStates.push(ready),
    }),
    installShutdownHandlers: (config: { cleanup: () => void | Promise<void> }) => ({
      shutdown: async () => {
        await config.cleanup();
        captured.cleanedUp = true;
      },
      isShuttingDown: () => {
        iteration += 1;
        return iteration > 1; // run exactly one loop body
      },
    }),
    createMaintenanceScheduler: (tasks: { name: string }[]) => {
      captured.scheduledTasks = tasks.map((t) => t.name);
      return {
        runDue: async () => {
          captured.ranDueCount += 1;
        },
        nextRunAt: () => undefined,
      };
    },
  }));

  // Spread the real modules so overriding the loader entrypoints never strips
  // other exports (e.g. createScannerRuntime) that sibling test files load through
  // the same process-global module registry.
  const realRegistryRuntime = await import("@hootifactory/registry-runtime");
  await mock.module("@hootifactory/registry-runtime", () => ({
    ...realRegistryRuntime,
    loadConfiguredRegistryPlugins: () => {},
  }));
  const realScannerRuntime = await import("@hootifactory/scanner-runtime");
  await mock.module("@hootifactory/scanner-runtime", () => ({
    ...realScannerRuntime,
    loadConfiguredScanners: () => ({ registered: [], unknown: ["typo-scanner"] }),
  }));

  // Inject the loop collaborators rather than mock.module-ing ./pipeline /
  // ./worker-loop (process-global; leaked into the sibling suites). worker.ts's
  // auto-start is guarded by import.meta.main, so importing it here is inert.
  const { runScanWorker } = await import("./worker");
  await runScanWorker({
    scannerRuntimeFromEnv: () =>
      ({
        options: {},
        scanners: [{ plugin: { id: "heuristic" }, available: true, config: null }],
      }) as unknown as ScannerRuntime,
    reapExpiredUploads: async () => {},
    sweepBlobs: async () => {},
    reclaimStuckScans: async () => {},
    runScanCycle: (async (config: unknown) => {
      captured.cycleCount += 1;
      captured.cycleConfig = config;
      return 0;
    }) as typeof import("./worker-loop").runScanCycle,
  });
})();

afterAll(() => {
  mock.restore();
});

describe("scan worker entrypoint wiring", () => {
  test("warns about unknown scanners reported by the loader", () => {
    expect(captured.unknownWarned).toBe(true);
  });

  test("toggles readiness on once the worker is wired", () => {
    expect(captured.readyStates).toContain(true);
  });

  test("registers the three maintenance tasks with the scheduler", () => {
    expect(captured.scheduledTasks).toEqual([
      "upload_sessions.reap_expired",
      "blob_gc.sweep",
      "scan.outbox.reclaim_stuck",
    ]);
  });

  test("runs maintenance and a scan cycle each loop iteration", () => {
    expect(captured.ranDueCount).toBe(1);
    expect(captured.cycleCount).toBe(1);
  });

  test("passes the resolved config (production fallbacks) into the scan cycle", () => {
    expect(captured.cycleConfig).toMatchObject({
      batchSize: 16,
      concurrency: 4,
      maxAttempts: 5,
    });
  });
});

/** A promise the test settles on demand (the loop's scan cycle hangs on it). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ShutdownHarness {
  /** runScanWorker's own promise; settles once the loop exits. */
  run: Promise<void>;
  /** Unblock the in-flight runScanCycle. */
  finishCycle: () => void;
  /**
   * Simulate runtime.ts's shutdown(): flip isShuttingDown() first, then run the
   * cleanup that runScanWorker registered, returning its completion promise.
   */
  triggerCleanup: () => Promise<void>;
}

/**
 * Start runScanWorker with EVERY collaborator injected through ScanWorkerDeps
 * (no mock.module): a controllable runScanCycle that blocks mid-iteration, plus
 * fake health-server / shutdown-controller / scheduler lifecycles so the test
 * owns isShuttingDown() and can invoke the registered cleanup directly. Resolves
 * once the first cycle is in flight.
 */
async function startShutdownHarness(options: {
  shutdownGraceMs: number;
  cycleNeverSettles?: boolean;
}): Promise<ShutdownHarness> {
  const { runScanWorker } = await import("./worker");
  const cycleStarted = deferred();
  const cycleGate = deferred();
  let shuttingDown = false;
  let cleanup: (() => void | Promise<void>) | undefined;
  const run = runScanWorker({
    scannerRuntimeFromEnv: () =>
      ({
        options: {},
        scanners: [{ plugin: { id: "heuristic" }, available: true, config: null }],
      }) as unknown as ScannerRuntime,
    reapExpiredUploads: async () => {},
    sweepBlobs: async () => {},
    reclaimStuckScans: async () => {},
    runScanCycle: async () => {
      cycleStarted.resolve();
      if (options.cycleNeverSettles) {
        await new Promise<void>(() => {});
      } else {
        await cycleGate.promise;
      }
      return 0;
    },
    startHealthServer: () => ({ server: null, setReady: () => {} }),
    installShutdownHandlers: (config) => {
      cleanup = config.cleanup;
      return {
        shutdown: async () => {},
        isShuttingDown: () => shuttingDown,
      };
    },
    createMaintenanceScheduler: () => ({
      runDue: async () => {},
      nextRunAt: () => undefined,
    }),
    shutdownGraceMs: options.shutdownGraceMs,
  });
  await cycleStarted.promise;
  return {
    run,
    finishCycle: cycleGate.resolve,
    triggerCleanup: () => {
      shuttingDown = true;
      if (!cleanup) throw new Error("installShutdownHandlers was not invoked");
      return Promise.resolve(cleanup());
    },
  };
}

describe("scan worker shutdown drain (#317)", () => {
  test("cleanup waits for the in-flight scan cycle before completing", async () => {
    const harness = await startShutdownHarness({ shutdownGraceMs: 5_000 });
    let cleanupSettled = false;
    const cleanupRun = harness.triggerCleanup().then(() => {
      cleanupSettled = true;
    });
    // Give cleanup ample macrotask turns to (incorrectly) settle while the
    // claimed batch is still mid-scan.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleanupSettled).toBe(false);
    harness.finishCycle();
    await cleanupRun;
    expect(cleanupSettled).toBe(true);
    // The drained iteration is done and isShuttingDown() is true: the loop exits.
    await harness.run;
  });

  test("cleanup completes after the grace period when the cycle never settles", async () => {
    const harness = await startShutdownHarness({
      shutdownGraceMs: 25,
      cycleNeverSettles: true,
    });
    // Must resolve (bounded by the grace race) even though the cycle hangs
    // forever — the SIGTERM path can never be allowed to hang the process.
    await harness.triggerCleanup();
    expect(captured.warnings.some((msg) => msg.includes("grace period expired"))).toBe(true);
  });
});
