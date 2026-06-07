import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * checkReadiness probes db / storage / queue concurrently and reports a
 * per-dependency ok flag plus an overall ready boolean. Mock each collaborator
 * so the failure-isolation and aggregation logic runs without real services.
 */
async function loadReadiness(overrides: {
  dbThrows?: boolean;
  storageThrows?: boolean;
  queueMissing?: boolean;
}) {
  const realDb = await import("@hootifactory/db");
  const realStorage = await import("@hootifactory/storage");
  const realQueue = await import("@hootifactory/queue");
  await mock.module("@hootifactory/db", () => ({
    ...realDb,
    db: {
      execute: async () => {
        if (overrides.dbThrows) throw new Error("db down");
        return { rows: [{ "?column?": 1 }] };
      },
    },
  }));
  await mock.module("@hootifactory/storage", () => ({
    ...realStorage,
    blobStore: {
      statKey: async () => {
        if (overrides.storageThrows) throw new Error("s3 down");
        return null;
      },
    },
  }));
  await mock.module("@hootifactory/queue", () => ({
    ...realQueue,
    QUEUES: { scan: "scan-queue" },
    getBoss: async () => ({
      getQueue: async () => (overrides.queueMissing ? null : { name: "scan-queue" }),
    }),
  }));
  return import("./readiness");
}

describe("checkReadiness", () => {
  afterEach(() => mock.restore());

  test("reports ready when all dependencies pass", async () => {
    const { checkReadiness } = await loadReadiness({});
    const state = await checkReadiness();
    expect(state.ready).toBe(true);
    expect(state.checks).toEqual([
      { name: "db", ok: true },
      { name: "storage", ok: true },
      { name: "queue", ok: true },
    ]);
  });

  test("marks only the failing dependency and reports not-ready", async () => {
    const { checkReadiness } = await loadReadiness({ storageThrows: true });
    const state = await checkReadiness();
    expect(state.ready).toBe(false);
    expect(state.checks.find((c) => c.name === "storage")?.ok).toBe(false);
    expect(state.checks.find((c) => c.name === "db")?.ok).toBe(true);
  });

  test("treats a missing queue as a failed queue dependency", async () => {
    const { checkReadiness } = await loadReadiness({ queueMissing: true });
    const state = await checkReadiness();
    expect(state.ready).toBe(false);
    expect(state.checks.find((c) => c.name === "queue")?.ok).toBe(false);
  });

  test("isolates a db failure from the other checks", async () => {
    const { checkReadiness } = await loadReadiness({ dbThrows: true });
    const state = await checkReadiness();
    expect(state.checks.find((c) => c.name === "db")?.ok).toBe(false);
    expect(state.checks.find((c) => c.name === "storage")?.ok).toBe(true);
    expect(state.checks.find((c) => c.name === "queue")?.ok).toBe(true);
  });
});
