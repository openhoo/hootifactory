import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * applyRetention runs a multi-statement transaction of raw `tx.execute(sql)`
 * reads/writes plus a couple of builder reads. The execute() stub yields the
 * next configured row batch in call order; the builder `.then` yields the next
 * awaited row batch. This drives the prune accounting without a database.
 */
function fakeDb(opts: { builderRows?: unknown[][]; executeRows?: unknown[][] }) {
  const calls: { op: string; args: unknown[] }[] = [];
  let executeCount = 0;
  let builderDepth = 0;
  const executeRows = opts.executeRows ?? [];
  const builderRows = opts.builderRows ?? [];
  const handler: ProxyHandler<(...a: unknown[]) => unknown> = {
    get(_t, prop) {
      if (prop === "then") {
        // Awaited builder reads in order: the repo lookup (first) and any further
        // builder reads inside the digest-reconciliation branch.
        const rows = builderRows[builderDepth] ?? builderRows[builderRows.length - 1] ?? [];
        builderDepth += 1;
        return (resolve: (v: unknown) => unknown) => resolve(rows);
      }
      if (prop === "transaction") {
        return (cb: (tx: unknown) => Promise<unknown>) => cb(builder);
      }
      if (prop === "execute") {
        return async () => {
          const rows = executeRows[executeCount] ?? [];
          executeCount += 1;
          return rows;
        };
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

async function withMocks<T>(
  opts: { builderRows?: unknown[][]; executeRows?: unknown[][] },
  run: () => Promise<T>,
): Promise<T> {
  const realDb = await import("@hootifactory/db");
  const realStorage = await import("@hootifactory/storage");
  const { builder } = fakeDb(opts);
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: builder }));
  await mock.module("@hootifactory/storage", () => ({
    ...realStorage,
    blobStore: { delete: async () => {} },
  }));
  // deleteUnreferencedCasBlob is imported from ../content and itself opens a tx;
  // stub it so the post-commit CAS sweep is a no-op.
  await mock.module("../content", () => ({ deleteUnreferencedCasBlob: async () => {} }));
  return run();
}

describe("applyRetention", () => {
  afterEach(() => mock.restore());

  test("returns 0 when the repository does not exist", async () => {
    const pruned = await withMocks({ builderRows: [[]] }, async () => {
      const { applyRetention } = await import("./retention");
      return applyRetention("repo_missing", 5);
    });
    expect(pruned).toBe(0);
  });

  test("returns 0 when nothing exceeds the keep window", async () => {
    const pruned = await withMocks(
      {
        builderRows: [[{ orgId: "org_1", moduleId: "npm" }]],
        executeRows: [[]], // prune update returns no rows
      },
      async () => {
        const { applyRetention } = await import("./retention");
        return applyRetention("repo_1", 10);
      },
    );
    expect(pruned).toBe(0);
  });

  test("prunes versions and reports the count when no blob digests are referenced", async () => {
    const pruned = await withMocks(
      {
        builderRows: [[{ orgId: "org_1", moduleId: "npm" }]],
        executeRows: [
          // prune update returning two versions with empty metadata (no digests)
          [
            { id: "v1", packageId: "p1", metadata: {} },
            { id: "v2", packageId: "p1", metadata: {} },
          ],
          [], // pruned assets returning none
          [], // deleted tags returning none
          [], // latest_version recompute (no returning)
        ],
      },
      async () => {
        const { applyRetention } = await import("./retention");
        return applyRetention("repo_1", 1);
      },
    );
    expect(pruned).toBe(2);
  });

  test("releases blob refs for pruned assets whose digest no surviving version needs", async () => {
    const pruned = await withMocks(
      {
        // builder reads, in order: repo lookup, then the live-versions read inside
        // the digest-reconciliation branch (none live).
        builderRows: [[{ orgId: "org_1", moduleId: "npm" }], []],
        executeRows: [
          [{ id: "v1", packageId: "p1", metadata: {} }], // prune returning 1 version
          [{ digest: "sha256:dead" }], // pruned assets returning a digest
          [{ packageId: "p1", tag: "latest" }], // deleted tags incl. the latest tag
          [], // latest_version recompute
          [], // latest-tag re-point (latestTagPackageIds present)
          [], // live registry_assets referencing the candidate digests: none
          [], // advisory locks for release digests
          [{ digest: "sha256:dead" }], // deleted blob_refs returning
          [{ digest: "sha256:dead", refCount: 0, sizeBytes: 10, stillReferencedByOrg: false }], // released blobs
          [], // adjustStorageUsedTx update (storageDelta != 0)
        ],
      },
      async () => {
        const { applyRetention } = await import("./retention");
        return applyRetention("repo_1", 1);
      },
    );
    expect(pruned).toBe(1);
  });
});
