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
 */

interface Captured {
  readyStates: boolean[];
  cleanedUp: boolean;
  unknownWarned: boolean;
  scheduledTasks: string[];
  ranDueCount: number;
  cycleCount: number;
  cycleConfig: unknown;
}

const captured: Captured = {
  readyStates: [],
  cleanedUp: false,
  unknownWarned: false,
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
        if (msg.includes("unknown scanners")) captured.unknownWarned = true;
      },
      error: () => {},
    },
  }));

  const realQueue = await import("@hootifactory/queue");
  await mock.module("@hootifactory/queue", () => ({
    ...realQueue,
    intEnv: (_name: string, fallback: number) => fallback,
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
