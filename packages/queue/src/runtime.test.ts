import { afterEach, describe, expect, test } from "bun:test";
import type { Job } from "pg-boss";
import {
  installShutdownHandlers,
  type RunWorkerDeps,
  runWorker,
  startHealthServer,
} from "./runtime";

/**
 * runtime.ts is the shared worker lifecycle. The signal/health primitives are
 * tested directly. `runWorker` is exercised with injected fake `work`/`stopBoss`
 * deps (no pg-boss, no database), and with `process.exit` plus process signal
 * handlers intercepted so nothing touches a real database, network port, or the
 * test runner's process lifecycle. Using dependency injection (rather than
 * mocking the boss module) keeps coverage attributed to this statically-imported
 * module under Bun's parallel runner.
 */

describe("startHealthServer", () => {
  test("is a no-op (no server) when no port is configured", () => {
    const health = startHealthServer("test-worker", undefined);
    expect(health.server).toBeNull();
    // setReady is still callable and harmless without a server.
    expect(() => health.setReady(true)).not.toThrow();
  });

  test("serves 503 until ready, then 200, when a port is configured", async () => {
    const health = startHealthServer("test-worker", 0); // ephemeral port
    expect(health.server).not.toBeNull();
    const port = health.server?.port;
    try {
      const starting = await fetch(`http://127.0.0.1:${port}/worker/healthz`);
      expect(starting.status).toBe(503);
      await starting.text();

      health.setReady(true);
      const ok = await fetch(`http://127.0.0.1:${port}/worker/healthz`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("ok");
    } finally {
      await health.server?.stop(true);
    }
  });
});

describe("installShutdownHandlers", () => {
  const signals = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"] as const;

  function withIntercepts<T>(run: () => Promise<T>): Promise<T> {
    const originalExit = process.exit;
    const before = new Map(signals.map((s) => [s, process.listeners(s).slice()]));
    process.exit = (() => {}) as unknown as typeof process.exit;
    return run().finally(() => {
      process.exit = originalExit;
      // Remove only the handlers this test added, restoring the prior set.
      for (const s of signals) {
        for (const l of process.listeners(s)) {
          if (!before.get(s)?.includes(l)) process.removeListener(s, l as never);
        }
      }
    });
  }

  test("runs cleanup once and reports shutting-down state", async () => {
    await withIntercepts(async () => {
      let cleanups = 0;
      const controller = installShutdownHandlers({
        logLabel: "test worker",
        cleanup: () => {
          cleanups += 1;
        },
      });
      expect(controller.isShuttingDown()).toBe(false);

      await controller.shutdown("SIGTERM");
      expect(controller.isShuttingDown()).toBe(true);
      expect(cleanups).toBe(1);

      // Idempotent: a second shutdown does not re-run cleanup.
      await controller.shutdown("SIGINT");
      expect(cleanups).toBe(1);
    });
  });

  test("still completes shutdown when cleanup throws", async () => {
    await withIntercepts(async () => {
      const controller = installShutdownHandlers({
        logLabel: "test worker",
        cleanup: () => {
          throw new Error("cleanup boom");
        },
      });
      // A failing cleanup is caught/logged, not propagated.
      await controller.shutdown("uncaughtException", 1, new Error("fatal"));
      expect(controller.isShuttingDown()).toBe(true);
    });
  });

  test("registers handlers for every lifecycle signal", async () => {
    await withIntercepts(async () => {
      const before = new Map(signals.map((s) => [s, process.listeners(s).length]));
      installShutdownHandlers({ logLabel: "test worker", cleanup: () => {} });
      for (const s of signals) {
        expect(process.listeners(s).length).toBe((before.get(s) ?? 0) + 1);
      }
    });
  });
});

describe("runWorker", () => {
  interface Registered {
    queue: string;
    handler: (jobs: Job<{ id: string; telemetry?: unknown }>[]) => Promise<void>;
    options: { batchSize: number; pollingIntervalSeconds: number };
  }

  /** A fake `work`/`stopBoss` pair that records the registration and lets the
   * test drive the batch handler, plus the process-exit/signal intercepts. */
  function makeHarness() {
    const registered: Registered[] = [];
    const completed: { queue: string; ids: string[] }[] = [];
    let stopBossCalls = 0;
    const deps: RunWorkerDeps = {
      work: (async (
        queue: string,
        handler: (jobs: Job<{ id: string; telemetry?: unknown }>[]) => Promise<void>,
        options?: { batchSize?: number; pollingIntervalSeconds?: number },
      ) => {
        registered.push({
          queue,
          handler,
          options: {
            batchSize: options?.batchSize ?? 0,
            pollingIntervalSeconds: options?.pollingIntervalSeconds ?? 0,
          },
        });
        return `worker-${registered.length}`;
      }) as unknown as RunWorkerDeps["work"],
      stopBoss: (async () => {
        stopBossCalls += 1;
      }) as RunWorkerDeps["stopBoss"],
      completeJobs: async (queue: string, ids: string[]) => {
        completed.push({ queue, ids });
      },
    };
    return { deps, registered, completed, stopBossCalls: () => stopBossCalls };
  }

  const originalPort = process.env.WORKER_PORT;
  const originalExit = process.exit;
  const signals = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"] as const;
  let before: Map<(typeof signals)[number], unknown[]>;

  function intercept() {
    before = new Map(signals.map((s) => [s, process.listeners(s).slice()]));
    process.exit = (() => {}) as unknown as typeof process.exit;
  }

  afterEach(async () => {
    process.exit = originalExit;
    for (const s of signals) {
      for (const l of process.listeners(s)) {
        if (!before?.get(s)?.includes(l)) process.removeListener(s, l as never);
      }
    }
    if (originalPort === undefined) delete process.env.WORKER_PORT;
    else process.env.WORKER_PORT = originalPort;
  });

  test("registers a consumer with the configured batch settings and processes jobs", async () => {
    delete process.env.WORKER_PORT; // skip the health server in this test
    intercept();
    const { deps, registered, completed } = makeHarness();

    const handled: { id: string }[] = [];
    await runWorker<{ id: string }>(
      {
        role: "test-worker",
        logLabel: "test worker",
        queue: "scan.artifact",
        batchSize: 4,
        pollingIntervalSeconds: 2,
        handleJob: async (data) => {
          handled.push(data);
        },
        jobLogAttributes: (data) => ({ "artifact.id": data.id }),
        startLog: () => ({ extra: "field" }),
      },
      deps,
    );

    expect(registered).toHaveLength(1);
    const consumer = registered[0];
    if (!consumer) throw new Error("expected a registered consumer");
    expect(consumer).toMatchObject({
      queue: "scan.artifact",
      options: { batchSize: 4, pollingIntervalSeconds: 2 },
    });

    // Drive the registered batch handler to prove handleJob runs per job, with
    // the per-job instrumentation wrapper, and that each success is acked
    // individually as it completes.
    await consumer.handler([
      { id: "j1", data: { id: "a1" } } as Job<{ id: string }>,
      { id: "j2", data: { id: "a2" } } as Job<{ id: string }>,
    ]);
    expect(handled).toEqual([{ id: "a1" }, { id: "a2" }]);
    expect(completed).toEqual([
      { queue: "scan.artifact", ids: ["j1"] },
      { queue: "scan.artifact", ids: ["j2"] },
    ]);
  });

  test("isolates job failures within a batch: siblings still run and are acked", async () => {
    delete process.env.WORKER_PORT;
    intercept();
    const { deps, registered, completed } = makeHarness();

    const handled: string[] = [];
    await runWorker<{ id: string }>(
      {
        role: "test-worker",
        logLabel: "test worker",
        queue: "email.send",
        batchSize: 3,
        pollingIntervalSeconds: 1,
        handleJob: async (data) => {
          if (data.id === "bad") throw new Error("job boom");
          handled.push(data.id);
        },
        jobLogAttributes: (data) => ({ "job.id": data.id }),
      },
      deps,
    );

    const consumer = registered[0];
    if (!consumer) throw new Error("expected a registered consumer");

    // The middle job throws: the later sibling must still be processed and both
    // successes acked per-job, then the handler rejects with an aggregate so
    // pg-boss fails (and retries) only the still-active job.
    const batch = consumer.handler([
      { id: "j1", data: { id: "ok-1" } } as Job<{ id: string }>,
      { id: "j2", data: { id: "bad" } } as Job<{ id: string }>,
      { id: "j3", data: { id: "ok-2" } } as Job<{ id: string }>,
    ]);
    await expect(batch).rejects.toThrow("1 of 3 email.send job(s) failed");
    await expect(batch).rejects.toBeInstanceOf(AggregateError);
    expect(handled).toEqual(["ok-1", "ok-2"]);
    expect(completed).toEqual([
      { queue: "email.send", ids: ["j1"] },
      { queue: "email.send", ids: ["j3"] },
    ]);
  });

  test("a failed per-job ack counts as a job failure so the job is retried", async () => {
    delete process.env.WORKER_PORT;
    intercept();
    const { deps, registered, completed } = makeHarness();
    deps.completeJobs = async (queue: string, ids: string[]) => {
      if (ids.includes("j1")) throw new Error("ack failed");
      completed.push({ queue, ids });
    };

    await runWorker<{ id: string }>(
      {
        role: "test-worker",
        logLabel: "test worker",
        queue: "email.send",
        batchSize: 2,
        pollingIntervalSeconds: 1,
        handleJob: async () => {},
        jobLogAttributes: () => ({}),
      },
      deps,
    );

    const consumer = registered[0];
    if (!consumer) throw new Error("expected a registered consumer");
    const batch = consumer.handler([
      { id: "j1", data: { id: "a1" } } as Job<{ id: string }>,
      { id: "j2", data: { id: "a2" } } as Job<{ id: string }>,
    ]);
    // j1's ack failure surfaces as a batch-level aggregate; j2 was still acked.
    await expect(batch).rejects.toThrow("1 of 2 email.send job(s) failed");
    expect(completed).toEqual([{ queue: "email.send", ids: ["j2"] }]);
  });

  test("starts a readiness health server when WORKER_PORT is set (object startLog)", async () => {
    process.env.WORKER_PORT = "0";
    intercept();
    const { deps, registered } = makeHarness();

    await runWorker<{ id: string }>(
      {
        role: "test-worker",
        logLabel: "test worker",
        queue: "gc.sweep",
        batchSize: 1,
        pollingIntervalSeconds: 1,
        handleJob: async () => {},
        jobLogAttributes: () => ({}),
        // Plain-object startLog branch (not a thunk).
        startLog: { mode: "object" },
      },
      deps,
    );

    expect(registered[0]?.queue).toBe("gc.sweep");
  });

  test("the shutdown cleanup stops the boss and runs onShutdown", async () => {
    delete process.env.WORKER_PORT;
    intercept();
    const { deps, stopBossCalls } = makeHarness();
    let onShutdownCalls = 0;

    await runWorker<{ id: string }>(
      {
        role: "test-worker",
        logLabel: "test worker",
        queue: "retention.apply",
        batchSize: 2,
        pollingIntervalSeconds: 3,
        handleJob: async () => {},
        jobLogAttributes: () => ({}),
        onShutdown: () => {
          onShutdownCalls += 1;
        },
      },
      deps,
    );

    // The SIGTERM listener runtime installed drives the shutdown lifecycle.
    process.emit("SIGTERM");
    // Allow the async shutdown chain (cleanup → stopBoss) to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onShutdownCalls).toBe(1);
    expect(stopBossCalls()).toBe(1);
  });

  test("falls back to shutdown when worker startup fails", async () => {
    delete process.env.WORKER_PORT;
    intercept();
    const failingDeps: RunWorkerDeps = {
      work: (async () => {
        throw new Error("registration failed");
      }) as unknown as RunWorkerDeps["work"],
      stopBoss: (async () => {}) as RunWorkerDeps["stopBoss"],
      completeJobs: async () => {},
    };

    // runWorker swallows the startup error into the shutdown path (does not throw).
    await runWorker<{ id: string }>(
      {
        role: "test-worker",
        logLabel: "test worker",
        queue: "scan.artifact",
        batchSize: 1,
        pollingIntervalSeconds: 1,
        handleJob: async () => {},
        jobLogAttributes: () => ({}),
      },
      failingDeps,
    );
    // Reaching here without throwing is the assertion: the rejection was handled.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(true).toBe(true);
  });
});
