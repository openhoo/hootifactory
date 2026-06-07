import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

function fakeDb(rowsByCall: unknown[][] = [], executeRows: unknown[][] = []) {
  const calls: { op: string; args: unknown[] }[] = [];
  let resolveCount = 0;
  let executeCount = 0;
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
  opts: {
    rowsByCall?: unknown[][];
    executeRows?: unknown[][];
    deleteKey?: (k: string) => Promise<void>;
  },
  run: (calls: { op: string; args: unknown[] }[]) => Promise<T>,
): Promise<T> {
  const realDb = await import("@hootifactory/db");
  const realStorage = await import("@hootifactory/storage");
  const { builder, calls } = fakeDb(opts.rowsByCall ?? [], opts.executeRows ?? []);
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: builder }));
  await mock.module("@hootifactory/storage", () => ({
    ...realStorage,
    blobStore: { deleteKey: opts.deleteKey ?? (async () => {}) },
  }));
  return run(calls);
}

const ctx = () => createTestRegistryContext();

describe("createContentUploadSession", () => {
  afterEach(() => mock.restore());

  test("inserts the open session row", async () => {
    await withMocks({ rowsByCall: [[]] }, async (calls) => {
      const { createContentUploadSession } = await import("./upload-sessions");
      await createContentUploadSession(ctx(), {
        id: "uuid-1",
        scope: "s",
        storageKey: "key",
        offsetBytes: 0,
        expiresAt: new Date(),
      });
      const values = calls.find((c) => c.op === "values");
      expect(values?.args[0]).toMatchObject({ id: "uuid-1", scope: "s", offsetBytes: 0 });
    });
  });
});

describe("loadContentUploadSession", () => {
  afterEach(() => mock.restore());

  test("returns the matched session row or null", async () => {
    const found = await withMocks({ rowsByCall: [[{ id: "uuid-1", state: "open" }]] }, async () => {
      const { loadContentUploadSession } = await import("./upload-sessions");
      return loadContentUploadSession(ctx(), { scope: "s", uuid: "uuid-1" });
    });
    expect(found).toMatchObject({ id: "uuid-1" });

    const none = await withMocks({ rowsByCall: [[]] }, async () => {
      const { loadContentUploadSession } = await import("./upload-sessions");
      return loadContentUploadSession(ctx(), { scope: "s", uuid: "uuid-2" });
    });
    expect(none).toBeNull();
  });
});

describe("markContentUploadSessionAborted", () => {
  afterEach(() => mock.restore());

  test("flips the open session to aborted", async () => {
    await withMocks({ rowsByCall: [[]] }, async (calls) => {
      const { markContentUploadSessionAborted } = await import("./upload-sessions");
      await markContentUploadSessionAborted(ctx(), { scope: "s", uuid: "uuid-1" });
      const set = calls.find((c) => c.op === "set");
      expect(set?.args[0]).toMatchObject({ state: "aborted" });
    });
  });
});

describe("listContentMountSources", () => {
  afterEach(() => mock.restore());

  test("returns the repositories referencing a digest", async () => {
    const rows = await withMocks(
      {
        rowsByCall: [
          [{ orgId: "o", id: "r1", mountPath: "v2/acme/c", visibility: "private", scope: "s" }],
        ],
      },
      async () => {
        const { listContentMountSources } = await import("./upload-sessions");
        return listContentMountSources("sha256:d");
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r1", mountPath: "v2/acme/c" });
  });
});

describe("withLockedContentUploadSession", () => {
  afterEach(() => mock.restore());

  test("loads the session and exposes mutation handles to the runner", async () => {
    const result = await withMocks(
      { rowsByCall: [[{ id: "uuid-1", state: "open" }]] },
      async (calls) => {
        const { withLockedContentUploadSession } = await import("./upload-sessions");
        return withLockedContentUploadSession(ctx(), {
          scope: "s",
          uuid: "uuid-1",
          run: async (session, mutations) => {
            expect(session).toMatchObject({ id: "uuid-1" });
            await mutations.updateOpen({ offsetBytes: 10, multipart: "{}" });
            await mutations.commit(10);
            await mutations.markAborted();
            await mutations.deleteSession();
            expect(calls.map((c) => c.op)).toContain("update");
            expect(calls.map((c) => c.op)).toContain("delete");
            return "ran";
          },
        });
      },
    );
    expect(result).toBe("ran");
  });

  test("assertStagingBudget throws when the staged-bytes budget is exceeded", async () => {
    await withMocks(
      {
        // load session (locked), then lockOrgQuotaTx, then sumOpenUploadBytesForOrgTx.
        rowsByCall: [[{ id: "uuid-1", state: "open" }], [{ used: 0, max: null }], [{ bytes: 900 }]],
      },
      async () => {
        const { withLockedContentUploadSession } = await import("./upload-sessions");
        await expect(
          withLockedContentUploadSession(ctx(), {
            scope: "s",
            uuid: "uuid-1",
            run: async (_session, mutations) => {
              await mutations.assertStagingBudget({
                nextOffsetBytes: 200,
                maxStagedUploadBytes: 1000,
              });
            },
          }),
        ).rejects.toThrow();
      },
    );
  });

  test("assertStagingBudget passes when within the staged-bytes budget", async () => {
    await withMocks(
      {
        rowsByCall: [[{ id: "uuid-1", state: "open" }], [{ used: 0, max: null }], [{ bytes: 100 }]],
      },
      async () => {
        const { withLockedContentUploadSession } = await import("./upload-sessions");
        const ok = await withLockedContentUploadSession(ctx(), {
          scope: "s",
          uuid: "uuid-1",
          run: async (_session, mutations) => {
            await mutations.assertStagingBudget({
              nextOffsetBytes: 200,
              maxStagedUploadBytes: 1000,
            });
            return "ok";
          },
        });
        expect(ok).toBe("ok");
      },
    );
  });
});

describe("reapExpiredContentUploadSessions", () => {
  afterEach(() => mock.restore());

  test("deletes staging objects and aborts each expired session", async () => {
    const deletedKeys: string[] = [];
    await withMocks(
      {
        // The expired-session select uses tx.execute; subsequent update().returning() awaits resolve.
        executeRows: [
          [
            {
              id: "uuid-1",
              storageKey: "key1",
              multipart: JSON.stringify({ chunks: [{ key: "chunk1" }] }),
            },
          ],
        ],
        rowsByCall: [[{ id: "uuid-1" }]],
        deleteKey: async (k) => {
          deletedKeys.push(k);
        },
      },
      async () => {
        const { reapExpiredContentUploadSessions } = await import("./upload-sessions");
        const result = await reapExpiredContentUploadSessions({ limit: 10, now: new Date() });
        expect(result.aborted).toBe(1);
      },
    );
    expect(deletedKeys).toContain("key1");
    expect(deletedKeys).toContain("chunk1");
  });

  test("returns zero when no sessions are expired", async () => {
    await withMocks({ executeRows: [[]], rowsByCall: [[]] }, async () => {
      const { reapExpiredContentUploadSessions } = await import("./upload-sessions");
      const result = await reapExpiredContentUploadSessions();
      expect(result).toEqual({ aborted: 0 });
    });
  });
});
