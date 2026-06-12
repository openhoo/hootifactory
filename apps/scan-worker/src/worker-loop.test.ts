import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ScannerRuntime } from "@hootifactory/scanner";
import type { ScanLoopDeps, ScanWorkerConfig } from "./worker-loop";

/**
 * Unit tests for the scan-worker claim/process/maintenance logic, isolated from the
 * process entrypoint. The DB handle and the pipeline collaborators (processScan /
 * recordScanFailure) are injected through each function's seam — never by mocking the
 * process-global @hootifactory/db module, which raced the real handle in CI. The
 * content maintenance helpers (reap/sweep) are the only collaborators still stubbed at
 * the module level, and they touch no real DB/S3 once stubbed.
 */

interface DbCapture {
  executeResult: unknown;
  executeRejects: boolean;
  updates: { set: Record<string, unknown>; sawReturning: boolean }[];
  reclaimRows: { id: string }[];
  updateRejects: boolean;
}

function makeDb(capture: DbCapture): typeof import("@hootifactory/db").db {
  function updateChain(): unknown {
    const record = { set: {} as Record<string, unknown>, sawReturning: false };
    let pushed = false;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            if (!pushed) {
              capture.updates.push(record);
              pushed = true;
            }
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              capture.updateRejects
                ? reject(new Error("db update failed"))
                : resolve(record.sawReturning ? capture.reclaimRows : []);
          }
          return (...args: unknown[]) => {
            if (prop === "set") record.set = args[0] as Record<string, unknown>;
            if (prop === "returning") record.sawReturning = true;
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return {
    execute: async () => {
      if (capture.executeRejects) throw new Error("db execute failed");
      return capture.executeResult;
    },
    update: () => updateChain(),
  } as unknown as typeof import("@hootifactory/db").db;
}

const baseConfig: ScanWorkerConfig = {
  batchSize: 16,
  concurrency: 4,
  pollingIntervalSeconds: 0,
  maxAttempts: 5,
  uploadReaperBatchSize: 100,
  uploadReaperIntervalSeconds: 300,
  blobGcBatchSize: 100,
  blobGcGraceSeconds: 60,
  blobGcIntervalSeconds: 300,
  scanReclaimIntervalSeconds: 300,
  scanReclaimTimeoutSeconds: 900,
  retentionApplyBatchSize: 100,
  retentionApplyIntervalSeconds: 3600,
};

const runtime = { options: {}, scanners: [] } as unknown as ScannerRuntime;

interface Collaborators {
  capture: DbCapture;
  processed: string[];
  failures: { artifactId: string; err: unknown }[];
  reapCalls: number[];
  sweepCalls: { batch: number; grace: number }[];
  /** Fake db to pass into worker-loop functions that take a `dbClient` seam. */
  db: typeof import("@hootifactory/db").db;
  /** Loop deps (db + pipeline collaborators) for processClaimedIntent/runScanCycle. */
  deps: ScanLoopDeps;
}

async function loadModule(opts: {
  executeResult?: unknown;
  executeRejects?: boolean;
  reclaimRows?: { id: string }[];
  updateRejects?: boolean;
  processScan?: (artifactId: string) => Promise<void>;
  reapThrows?: boolean;
  sweepThrows?: boolean;
}): Promise<{ mod: typeof import("./worker-loop"); collab: Collaborators }> {
  const capture: DbCapture = {
    executeResult: opts.executeResult ?? { rows: [] },
    executeRejects: opts.executeRejects ?? false,
    updates: [],
    reclaimRows: opts.reclaimRows ?? [],
    updateRejects: opts.updateRejects ?? false,
  };
  const db = makeDb(capture);
  const collab: Collaborators = {
    capture,
    processed: [],
    failures: [],
    reapCalls: [],
    sweepCalls: [],
    db,
    deps: {
      db,
      processScan: (async (artifactId: string) => {
        collab.processed.push(artifactId);
        await opts.processScan?.(artifactId);
      }) as ScanLoopDeps["processScan"],
      recordScanFailure: (async (artifactId: string, err: unknown) => {
        collab.failures.push({ artifactId, err });
      }) as ScanLoopDeps["recordScanFailure"],
    },
  };

  // The reap/sweep helpers delegate to content maintenance functions that would
  // touch a real DB; stub just those two functions (not the @hootifactory/db handle)
  // while preserving the rest of the module surface (e.g. loadContentAddressableManifestRaw,
  // which the real ./pipeline still imports through this module).
  const realContent = await import("@hootifactory/registry-platform/content");
  await mock.module("@hootifactory/registry-platform/content", () => ({
    ...realContent,
    reapExpiredContentUploadSessions: async ({ limit }: { limit: number }) => {
      collab.reapCalls.push(limit);
      if (opts.reapThrows) throw new Error("reap failed");
      return { aborted: 2, cleaned: 2 };
    },
    sweepUnreferencedCasBlobs: async ({ limit, graceMs }: { limit: number; graceMs: number }) => {
      collab.sweepCalls.push({ batch: limit, grace: graceMs });
      if (opts.sweepThrows) throw new Error("sweep failed");
      return { candidates: 3, reclaimed: 1 };
    },
  }));

  const mod = await import("./worker-loop");
  return { mod, collab };
}

afterEach(() => {
  mock.restore();
});

describe("claimScanIntents", () => {
  test("normalizes the claim query's rows into scan intents", async () => {
    const { mod, collab } = await loadModule({
      executeResult: { rows: [{ id: "a", artifactId: "art-a", attempts: 1 }] },
    });
    const intents = await mod.claimScanIntents(16, collab.db);
    expect(intents).toEqual([{ id: "a", artifactId: "art-a", attempts: 1 }]);
  });
});

describe("markSucceeded / markFailed", () => {
  test("markSucceeded writes the succeeded terminal status", async () => {
    const { mod, collab } = await loadModule({});
    await mod.markSucceeded({ id: "a", artifactId: "art-a", attempts: 1 }, collab.db);
    expect(collab.capture.updates[0]?.set.status).toBe("succeeded");
    expect(collab.capture.updates[0]?.set.lastError).toBeNull();
  });

  test("markFailed re-queues as pending below the attempts cap", async () => {
    const { mod, collab } = await loadModule({});
    await mod.markFailed(
      { id: "a", artifactId: "art-a", attempts: 2 },
      new Error("x"),
      5,
      collab.db,
    );
    expect(collab.capture.updates[0]?.set.status).toBe("pending");
    expect(collab.capture.updates[0]?.set.lastError).toBe("x");
  });

  test("markFailed terminally fails once the attempts cap is reached", async () => {
    const { mod, collab } = await loadModule({});
    await mod.markFailed({ id: "a", artifactId: "art-a", attempts: 5 }, "boom", 5, collab.db);
    expect(collab.capture.updates[0]?.set.status).toBe("failed");
  });

  test("markFailed truncates long error messages", async () => {
    const { mod, collab } = await loadModule({});
    await mod.markFailed(
      { id: "a", artifactId: "art-a", attempts: 1 },
      "x".repeat(5000),
      5,
      collab.db,
    );
    expect((collab.capture.updates[0]?.set.lastError as string).length).toBe(2000);
  });
});

describe("sleep", () => {
  test("resolves after the given delay", async () => {
    const { mod } = await loadModule({});
    const start = Date.now();
    await mod.sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});

describe("maintenance tasks", () => {
  test("reapExpiredUploads forwards the batch size and tolerates errors", async () => {
    const ok = await loadModule({});
    await ok.mod.reapExpiredUploads(100);
    expect(ok.collab.reapCalls).toEqual([100]);

    const failing = await loadModule({ reapThrows: true });
    await expect(failing.mod.reapExpiredUploads(50)).resolves.toBeUndefined();
    expect(failing.collab.reapCalls).toEqual([50]);
  });

  test("sweepBlobs forwards batch + grace and tolerates errors", async () => {
    const ok = await loadModule({});
    await ok.mod.sweepBlobs(100, 60);
    expect(ok.collab.sweepCalls).toEqual([{ batch: 100, grace: 60_000 }]);

    const failing = await loadModule({ sweepThrows: true });
    await expect(failing.mod.sweepBlobs(10, 1)).resolves.toBeUndefined();
  });

  test("reclaimStuckScans issues the reclaim update and logs when rows are reclaimed", async () => {
    const { mod, collab } = await loadModule({ reclaimRows: [{ id: "stuck-1" }] });
    await mod.reclaimStuckScans(900, 5, collab.db);
    const reclaim = collab.capture.updates.find((u) => u.sawReturning);
    expect(reclaim?.set.lastError).toBe("reclaimed: worker stopped while processing");
  });

  test("reclaimStuckScans tolerates a failing update", async () => {
    const { mod, collab } = await loadModule({ updateRejects: true });
    await expect(mod.reclaimStuckScans(900, 5, collab.db)).resolves.toBeUndefined();
  });

  test("applyRetentionPolicies forwards the batch limit to the policy sweep", async () => {
    const { mod } = await loadModule({});
    const sweeps: { limit: number }[] = [];
    await mod.applyRetentionPolicies(25, async (opts) => {
      sweeps.push(opts);
      return { policies: 1, applied: 1, pruned: 2, skipped: 0, failed: 0 };
    });
    expect(sweeps).toEqual([{ limit: 25 }]);
  });

  test("applyRetentionPolicies tolerates a failing sweep", async () => {
    const { mod } = await loadModule({});
    await expect(
      mod.applyRetentionPolicies(10, async () => {
        throw new Error("policy query failed");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("processClaimedIntent", () => {
  test("marks succeeded when the pipeline completes", async () => {
    const { mod, collab } = await loadModule({});
    await mod.processClaimedIntent(
      { id: "a", artifactId: "art-a", attempts: 1 },
      runtime,
      5,
      collab.deps,
    );
    expect(collab.processed).toEqual(["art-a"]);
    expect(collab.capture.updates[0]?.set.status).toBe("succeeded");
    expect(collab.failures).toEqual([]);
  });

  test("restores the publish-time telemetry context around the scan (issue #341)", async () => {
    const { mod, collab } = await loadModule({});
    const restored: unknown[] = [];
    const telemetry = { requestId: "req-1", correlationId: "corr-1" };
    await mod.processClaimedIntent(
      { id: "a", artifactId: "art-a", attempts: 1, telemetry },
      runtime,
      5,
      {
        ...collab.deps,
        withTelemetryContext: (async (carrier, fn) => {
          restored.push(carrier);
          return fn();
        }) as NonNullable<ScanLoopDeps["withTelemetryContext"]>,
      },
    );
    // The carrier parsed off the claimed row is what gets restored, and the scan
    // pipeline + terminal write still run inside it.
    expect(restored).toEqual([telemetry]);
    expect(collab.processed).toEqual(["art-a"]);
    expect(collab.capture.updates[0]?.set.status).toBe("succeeded");
  });

  test("records the failure and marks failed when the pipeline throws", async () => {
    const { mod, collab } = await loadModule({
      processScan: async () => {
        throw new Error("scan exploded");
      },
    });
    await mod.processClaimedIntent(
      { id: "a", artifactId: "art-a", attempts: 5 },
      runtime,
      5,
      collab.deps,
    );
    expect(collab.failures.map((f) => f.artifactId)).toEqual(["art-a"]);
    expect(collab.capture.updates[0]?.set.status).toBe("failed");
  });

  test("resolves even when the markSucceeded terminal write fails", async () => {
    const { mod, collab } = await loadModule({ updateRejects: true });
    await mod.processClaimedIntent(
      { id: "a", artifactId: "art-a", attempts: 1 },
      runtime,
      5,
      collab.deps,
    );
    // The scan pipeline still ran (processed), but the terminal write failed
    // internally and was caught — the intent stays in 'processing' until
    // reclaimStuckScans picks it up.
    expect(collab.processed).toEqual(["art-a"]);
    expect(collab.failures).toEqual([]);
  });

  test("resolves even when the markFailed terminal write fails", async () => {
    const { mod, collab } = await loadModule({
      updateRejects: true,
      processScan: async () => {
        throw new Error("scan exploded");
      },
    });
    await mod.processClaimedIntent(
      { id: "a", artifactId: "art-a", attempts: 5 },
      runtime,
      5,
      collab.deps,
    );
    // The failure was recorded, but the terminal write failed internally and
    // was caught.
    expect(collab.failures.map((f) => f.artifactId)).toEqual(["art-a"]);
  });
});

describe("runScanCycle", () => {
  test("returns 0 and sleeps when nothing is claimed", async () => {
    const { mod, collab } = await loadModule({ executeResult: { rows: [] } });
    const processed = await mod.runScanCycle(baseConfig, runtime, collab.deps);
    expect(processed).toBe(0);
    expect(collab.processed).toEqual([]);
  });

  test("processes every claimed intent and returns the count", async () => {
    const { mod, collab } = await loadModule({
      executeResult: {
        rows: [
          { id: "a", artifactId: "art-a", attempts: 1 },
          { id: "b", artifactId: "art-b", attempts: 1 },
        ],
      },
    });
    const processed = await mod.runScanCycle(baseConfig, runtime, collab.deps);
    expect(processed).toBe(2);
    expect(collab.processed.sort()).toEqual(["art-a", "art-b"]);
    // both intents were finalized (two terminal writes)
    expect(collab.capture.updates.filter((u) => u.set.status === "succeeded")).toHaveLength(2);
  });

  test("tolerates a failing claim and returns 0 without crashing the loop", async () => {
    const { mod } = await loadModule({ executeRejects: true });
    const processed = await mod.runScanCycle(baseConfig, runtime);
    expect(processed).toBe(0);
  });
});
