import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * Chainable, awaitable drizzle stub. Each method records its call and returns the
 * chainable proxy; awaiting resolves to the next configured row batch in call
 * order. The same proxy doubles as the transaction handle.
 */
function fakeDb(rowsByCall: unknown[][] = []) {
  const calls: { op: string; args: unknown[] }[] = [];
  let resolveCount = 0;
  const handler: ProxyHandler<(...a: unknown[]) => unknown> = {
    get(_t, prop) {
      if (prop === "then") {
        const rows = rowsByCall[resolveCount] ?? rowsByCall[rowsByCall.length - 1] ?? [];
        resolveCount += 1;
        return (resolve: (v: unknown) => unknown) => resolve(rows);
      }
      if (prop === "transaction") {
        return (cb: (tx: unknown) => Promise<unknown>) => cb(builder);
      }
      return (...args: unknown[]) => {
        calls.push({ op: String(prop), args });
        return builder;
      };
    },
    apply() {
      return builder;
    },
  };
  const builder: any = new Proxy(() => {}, handler);
  return { builder, calls };
}

async function withFakeDb<T>(
  rowsByCall: unknown[][],
  run: (calls: { op: string; args: unknown[] }[]) => Promise<T>,
): Promise<T> {
  const real = await import("@hootifactory/db");
  const { builder, calls } = fakeDb(rowsByCall);
  await mock.module("@hootifactory/db", () => ({ ...real, db: builder }));
  return run(calls);
}

describe("upsertScanPolicy", () => {
  afterEach(() => mock.restore());

  test("upserts the policy, invalidates the cache, and returns the row", async () => {
    let invalidatedOrg: string | undefined;
    await mock.module("./scan-policy", () => ({
      invalidateRegistryScanPolicyCache: (orgId?: string) => {
        invalidatedOrg = orgId;
      },
    }));
    const row = await withFakeDb([[{ id: "sp_1", mode: "enforce" }]], async (calls) => {
      const { upsertScanPolicy } = await import("./governance");
      const r = await upsertScanPolicy({
        orgId: "org_1",
        repositoryPattern: "*",
        mode: "enforce",
        blockOnSeverity: "high",
      });
      expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
      return r;
    });
    expect(row).toEqual({ id: "sp_1", mode: "enforce" });
    expect(invalidatedOrg).toBe("org_1");
  });

  test("throws when the upsert returns no row", async () => {
    await mock.module("./scan-policy", () => ({ invalidateRegistryScanPolicyCache: () => {} }));
    await withFakeDb([[]], async () => {
      const { upsertScanPolicy } = await import("./governance");
      await expect(
        upsertScanPolicy({
          orgId: "org_1",
          repositoryPattern: "*",
          mode: "audit",
          blockOnSeverity: null,
        }),
      ).rejects.toThrow("scan policy upsert did not return a row");
    });
  });
});

describe("getOrgQuota", () => {
  afterEach(() => mock.restore());

  test("returns the persisted quota row", async () => {
    const quota = await withFakeDb(
      [[{ maxStorageBytes: 100, usedStorageBytes: 30, maxArtifacts: 5, usedArtifacts: 2 }]],
      async () => {
        const { getOrgQuota } = await import("./governance");
        return getOrgQuota("org_1");
      },
    );
    expect(quota).toEqual({
      maxStorageBytes: 100,
      usedStorageBytes: 30,
      maxArtifacts: 5,
      usedArtifacts: 2,
    });
  });

  test("falls back to unlimited/zero defaults when no row exists", async () => {
    const quota = await withFakeDb([[]], async () => {
      const { getOrgQuota } = await import("./governance");
      return getOrgQuota("org_1");
    });
    expect(quota).toEqual({
      maxStorageBytes: null,
      usedStorageBytes: 0,
      maxArtifacts: null,
      usedArtifacts: 0,
    });
  });
});

describe("calculateOrgQuotaUsage", () => {
  afterEach(() => mock.restore());

  test("sums storage bytes and counts live artifacts from the transaction", async () => {
    // First resolved read = storage sum, second = artifact count.
    const usage = await withFakeDb([[{ used: "4096" }], [{ used: 7 }]], async () => {
      const { calculateOrgQuotaUsage } = await import("./governance");
      const real = await import("@hootifactory/db");
      return calculateOrgQuotaUsage(real.db as any, "org_1");
    });
    expect(usage).toEqual({ usedStorageBytes: 4096, usedArtifacts: 7 });
  });
});

describe("setOrgQuota", () => {
  afterEach(() => mock.restore());

  test("locks the org row, recomputes usage, and writes absolute limits", async () => {
    // lock read, storage sum, artifact count.
    const state = await withFakeDb(
      [
        [{ used: 1, max: 10, usedArtifacts: 0, maxArtifacts: 5 }],
        [{ used: "2048" }],
        [{ used: 3 }],
      ],
      async (calls) => {
        const { setOrgQuota } = await import("./governance");
        const r = await setOrgQuota("org_1", { maxStorageBytes: 5000, maxArtifacts: 50 });
        // The absolute write is an upsert on the partial unique index.
        expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
        return r;
      },
    );
    expect(state).toEqual({
      maxStorageBytes: 5000,
      maxArtifacts: 50,
      usedStorageBytes: 2048,
      usedArtifacts: 3,
    });
  });
});
