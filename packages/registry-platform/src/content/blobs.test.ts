import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

/**
 * Chainable, awaitable drizzle stub. Builder methods record + return the chain;
 * awaiting resolves to the next configured row batch in call order. Doubles as
 * the transaction handle and exposes `execute` for raw-SQL reads.
 */
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
        return async (...args: unknown[]) => {
          calls.push({ op: "execute", args });
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

function fakeBlobStore(overrides: Record<string, unknown> = {}) {
  return {
    blobKey: (digest: string) => `blobs/${digest}`,
    put: async (data: Uint8Array, digest: string) => ({
      digest,
      size: data.byteLength,
      deduped: false,
    }),
    putStream: async () => ({ digest: "sha256:stream", size: 5, deduped: false }),
    stat: async () => ({ size: 5 }),
    delete: async () => {},
    get: () => "BYTES",
    getRange: () => "RANGE",
    ...overrides,
  };
}

async function withMocks<T>(
  opts: {
    rowsByCall?: unknown[][];
    executeRows?: unknown[][];
    blobStore?: Record<string, unknown>;
  },
  run: (ctx: { calls: { op: string; args: unknown[] }[]; tx: any }) => Promise<T>,
): Promise<T> {
  const realDb = await import("@hootifactory/db");
  const realStorage = await import("@hootifactory/storage");
  const { builder, calls } = fakeDb(opts.rowsByCall ?? [], opts.executeRows ?? []);
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: builder }));
  await mock.module("@hootifactory/storage", () => ({
    ...realStorage,
    blobStore: fakeBlobStore(opts.blobStore),
  }));
  return run({ calls, tx: builder });
}

describe("digest advisory locks", () => {
  afterEach(() => mock.restore());

  test("lockDigestsTx dedups + sorts the digests it locks", async () => {
    await withMocks({}, async ({ tx }) => {
      const { lockDigestsTx } = await import("./blobs");
      const execArgs: unknown[] = [];
      const recordingTx = {
        execute: async (sql: unknown) => {
          execArgs.push(sql);
          return [];
        },
      };
      await lockDigestsTx(recordingTx as any, ["c", "a", "a", "b"]);
      // 3 unique digests => 3 advisory locks.
      expect(execArgs).toHaveLength(3);
      void tx;
    });
  });
});

describe("ensureActiveBlobTx", () => {
  afterEach(() => mock.restore());

  test("inserts a fresh blob row without a follow-up reactivation", async () => {
    await withMocks({ rowsByCall: [[{ digest: "sha256:x" }]] }, async ({ tx, calls }) => {
      const { ensureActiveBlobTx } = await import("./blobs");
      const ctx = createTestRegistryContext();
      await ensureActiveBlobTx(tx, ctx, { digest: "sha256:x", size: 5 }, "application/json");
      // The insert ran; no UPDATE reactivation needed.
      expect(calls.map((c) => c.op)).toContain("insert");
      expect(calls.map((c) => c.op)).not.toContain("update");
    });
  });

  test("reactivates a pending-delete blob when the insert conflicts", async () => {
    await withMocks({ rowsByCall: [[]] }, async ({ tx, calls }) => {
      const { ensureActiveBlobTx } = await import("./blobs");
      const ctx = createTestRegistryContext();
      await ensureActiveBlobTx(tx, ctx, { digest: "sha256:x", size: 5 });
      expect(calls.map((c) => c.op)).toContain("update");
    });
  });
});

describe("insertBlobRefTx", () => {
  afterEach(() => mock.restore());

  test("reports created=true for a freshly inserted ref", async () => {
    const result = await withMocks({ rowsByCall: [[{ id: "ref_1" }]] }, async ({ tx }) => {
      const { insertBlobRefTx } = await import("./blobs");
      const ctx = createTestRegistryContext();
      return insertBlobRefTx(tx, ctx, { digest: "sha256:x", kind: "k", scope: "s" });
    });
    expect(result).toEqual({ id: "ref_1", created: true });
  });

  test("resolves the existing ref on conflict (created=false)", async () => {
    // insert returns no row, follow-up select finds the existing ref.
    const result = await withMocks(
      { rowsByCall: [[], [{ id: "ref_existing" }]] },
      async ({ tx }) => {
        const { insertBlobRefTx } = await import("./blobs");
        const ctx = createTestRegistryContext();
        return insertBlobRefTx(tx, ctx, { digest: "sha256:x", kind: "k", scope: "s" });
      },
    );
    expect(result).toEqual({ id: "ref_existing", created: false });
  });

  test("throws when neither insert nor select resolve a ref", async () => {
    await withMocks({ rowsByCall: [[], []] }, async ({ tx }) => {
      const { insertBlobRefTx } = await import("./blobs");
      const ctx = createTestRegistryContext();
      await expect(
        insertBlobRefTx(tx, ctx, { digest: "sha256:x", kind: "k", scope: "s" }),
      ).rejects.toThrow("failed to resolve blob ref after insert conflict");
    });
  });
});

describe("storeBlobWithRef", () => {
  afterEach(() => mock.restore());

  test("stores the blob and creates a new ref, returning the stored descriptor", async () => {
    // existingOrgRef read (none) -> assertStorageQuota read -> tx: lock, lock quota,
    // orgAlreadyReferences (none), ensureActiveBlob insert, insertBlobRef created.
    const stored = await withMocks(
      {
        rowsByCall: [
          [], // existingOrgRef: none
          [{ used: 0, max: null }], // assertStorageQuota row
          [{ used: 0, max: null }], // lockOrgQuotaTx
          [], // orgAlreadyReferencesDigestTx: none
          [{ digest: "sha256:d" }], // ensureActiveBlobTx insert created
          [{ id: "ref_1" }], // insertBlobRefTx created
        ],
      },
      async () => {
        const { storeBlobWithRef } = await import("./blobs");
        const ctx = createTestRegistryContext();
        return storeBlobWithRef(ctx, {
          data: new Uint8Array([1, 2, 3]),
          kind: "npm_tarball",
          scope: "demo@1.0.0",
        });
      },
    );
    expect(stored).toMatchObject({ blobRefId: "ref_1", refCreated: true, size: 3 });
  });

  test("discards the put and rethrows when the transaction fails", async () => {
    let discarded = 0;
    const stored = fakeBlobStore({
      put: async () => ({ digest: "sha256:d", size: 3, deduped: false }),
      delete: async () => {
        discarded += 1;
      },
    });
    await withMocks(
      {
        blobStore: stored,
        // existingOrgRef none, assertStorageQuota row, then the tx throws because
        // insertBlobRefTx finds neither an inserted nor existing ref.
        rowsByCall: [
          [],
          [{ used: 0, max: null }],
          [{ used: 0, max: null }],
          [],
          [{ digest: "d" }],
          [],
          [],
        ],
      },
      async () => {
        const { storeBlobWithRef } = await import("./blobs");
        const ctx = createTestRegistryContext();
        await expect(
          storeBlobWithRef(ctx, {
            data: new Uint8Array([1, 2, 3]),
            kind: "k",
            scope: "s",
          }),
        ).rejects.toThrow();
      },
    );
    // The transaction failed with no committed ref, so the rollback path must
    // have deleted the freshly-put (non-deduped, unrecorded) CAS blob exactly once.
    expect(discarded).toBe(1);
  });
});

describe("getBlobRef + blobRefExists", () => {
  afterEach(() => mock.restore());

  test("getBlobRef returns a referenced-blob handle or null", async () => {
    const found = await withMocks({ rowsByCall: [[{ size: 10 }]] }, async () => {
      const { getBlobRef } = await import("./blobs");
      const ctx = createTestRegistryContext();
      return getBlobRef(ctx, { digest: "sha256:x", kind: "k", scope: "s" });
    });
    expect(found).toMatchObject({ digest: "sha256:x", size: 10 });
    expect(found?.get() as unknown).toBe("BYTES");
    expect(found?.getRange(0, 1) as unknown).toBe("RANGE");

    const none = await withMocks({ rowsByCall: [[]] }, async () => {
      const { getBlobRef } = await import("./blobs");
      const ctx = createTestRegistryContext();
      return getBlobRef(ctx, { digest: "sha256:x", kind: "k", scope: "s" });
    });
    expect(none).toBeNull();
  });

  test("blobRefExists reflects whether a ref row was found", async () => {
    await withMocks({ rowsByCall: [[{ id: "ref_1" }]] }, async () => {
      const { blobRefExists } = await import("./blobs");
      const ctx = createTestRegistryContext();
      expect(await blobRefExists(ctx, { digest: "sha256:x", kind: "k", scope: "s" })).toBe(true);
    });
    await withMocks({ rowsByCall: [[]] }, async () => {
      const { blobRefExists } = await import("./blobs");
      const ctx = createTestRegistryContext();
      expect(await blobRefExists(ctx, { digest: "sha256:x", kind: "k", scope: "s" })).toBe(false);
    });
  });
});

describe("ensureBlobRef", () => {
  afterEach(() => mock.restore());

  test("charges the org and bumps refCount for a newly created ref", async () => {
    const result = await withMocks(
      {
        rowsByCall: [
          [{ size: 7 }], // blob exists
          [{ used: 0, max: null }], // lockOrgQuotaTx
          [], // orgAlreadyReferences: none -> charge
          [{ id: "ref_1" }], // insertBlobRefTx created
          [], // update blob refCount
        ],
      },
      async () => {
        const { ensureBlobRef } = await import("./blobs");
        return ensureBlobRef(createTestRegistryContext(), {
          digest: "sha256:d",
          kind: "k",
          scope: "s",
        });
      },
    );
    expect(result).toMatchObject({ blobRefId: "ref_1", refCreated: true, size: 7 });
  });

  test("returns the existing ref without re-charging when already referenced", async () => {
    const result = await withMocks(
      {
        rowsByCall: [
          [{ size: 7 }], // blob exists
          [{ used: 0, max: null }], // lockOrgQuotaTx
          [{ id: "x" }], // orgAlreadyReferences: yes -> no charge
          [], // insertBlobRef: conflict, no row
          [{ id: "ref_existing" }], // select existing ref
        ],
      },
      async () => {
        const { ensureBlobRef } = await import("./blobs");
        return ensureBlobRef(createTestRegistryContext(), {
          digest: "sha256:d",
          kind: "k",
          scope: "s",
        });
      },
    );
    expect(result).toEqual({
      digest: "sha256:d",
      size: 7,
      refCreated: false,
      blobRefId: "ref_existing",
    });
  });

  test("throws blobUnknown when the blob row is missing", async () => {
    await withMocks({ rowsByCall: [[]] }, async () => {
      const { ensureBlobRef } = await import("./blobs");
      await expect(
        ensureBlobRef(createTestRegistryContext(), { digest: "sha256:d", kind: "k", scope: "s" }),
      ).rejects.toThrow();
    });
  });
});

describe("releaseBlobRef + releaseRepoDigestTx", () => {
  afterEach(() => mock.restore());

  test("releaseBlobRef refunds the org and schedules CAS deletion when last ref drops", async () => {
    const result = await withMocks(
      {
        rowsByCall: [
          [{ id: "ref_1" }], // delete ref returning
          [{ refCount: 0, size: 5 }], // blob read
          [], // orgAlreadyReferences: none -> refund
        ],
      },
      async ({ tx }) => {
        const { releaseBlobRef } = await import("./blobs");
        await releaseBlobRef(createTestRegistryContext(), {
          digest: "sha256:d",
          kind: "k",
          scope: "s",
        });
        void tx;
      },
    );
    expect(result).toBeUndefined();
  });

  test("releaseBlobRef is a no-op when no ref row was deleted", async () => {
    await withMocks({ rowsByCall: [[]] }, async () => {
      const { releaseBlobRef } = await import("./blobs");
      await expect(
        releaseBlobRef(createTestRegistryContext(), { digest: "sha256:d", kind: "k", scope: "s" }),
      ).resolves.toBeUndefined();
    });
  });

  test("releaseRepoDigestTx returns the digest when the blob is fully dereferenced", async () => {
    const result = await withMocks(
      {
        rowsByCall: [
          [{ id: "ref_1" }], // delete refs returning
          [{ refCount: 0, size: 5 }], // blob read
          [], // orgAlreadyReferences: none -> refund
        ],
      },
      async ({ tx }) => {
        const { releaseRepoDigestTx } = await import("./blobs");
        return releaseRepoDigestTx(tx, { repositoryId: "r1", orgId: "org_1", digest: "sha256:d" });
      },
    );
    expect(result).toBe("sha256:d");
  });

  test("releaseRepoDigestTx returns null when nothing was deleted", async () => {
    const result = await withMocks({ rowsByCall: [[]] }, async ({ tx }) => {
      const { releaseRepoDigestTx } = await import("./blobs");
      return releaseRepoDigestTx(tx, { repositoryId: "r1", orgId: "org_1", digest: "sha256:d" });
    });
    expect(result).toBeNull();
  });
});

describe("storeBlobStreamWithRef", () => {
  afterEach(() => mock.restore());

  test("uploads the stream, verifies storage, then commits the ref", async () => {
    const stored = await withMocks(
      {
        blobStore: {
          putStream: async () => ({ digest: "sha256:stream", size: 9, deduped: false }),
          stat: async () => ({ size: 9 }),
        },
        rowsByCall: [
          [{ used: 0, max: null }], // lockOrgQuotaTx
          [], // orgAlreadyReferences: none
          [{ digest: "sha256:stream" }], // ensureActiveBlobTx insert
          [{ id: "ref_1" }], // insertBlobRefTx created
        ],
      },
      async () => {
        const { storeBlobStreamWithRef } = await import("./blobs");
        return storeBlobStreamWithRef(createTestRegistryContext(), {
          data: new ReadableStream() as any,
          kind: "k",
          scope: "s",
        });
      },
    );
    expect(stored).toMatchObject({ digest: "sha256:stream", size: 9, blobRefId: "ref_1" });
  });

  test("discards the upload and rethrows when the staged object is missing", async () => {
    let discarded = 0;
    await withMocks(
      {
        blobStore: {
          putStream: async () => ({ digest: "sha256:stream", size: 9, deduped: false }),
          stat: async () => null,
          delete: async () => {
            discarded += 1;
          },
        },
        rowsByCall: [[]],
      },
      async () => {
        const { storeBlobStreamWithRef } = await import("./blobs");
        await expect(
          storeBlobStreamWithRef(createTestRegistryContext(), {
            data: new ReadableStream() as any,
            kind: "k",
            scope: "s",
          }),
        ).rejects.toThrow();
      },
    );
    // stat() returning null means the staged object never landed, so the failure
    // path must discard the streamed (non-deduped, unrecorded) blob exactly once.
    expect(discarded).toBe(1);
  });
});

describe("discardUncommittedBlobPut + deleteUnreferencedCasBlob", () => {
  afterEach(() => mock.restore());

  test("discardUncommittedBlobPut deletes a non-deduped, unrecorded blob", async () => {
    let deleted = 0;
    await withMocks(
      {
        blobStore: {
          delete: async () => {
            deleted += 1;
          },
        },
        rowsByCall: [[]], // blobs select inside tx: not recorded
      },
      async () => {
        const { discardUncommittedBlobPut } = await import("./blobs");
        await discardUncommittedBlobPut(createTestRegistryContext(), {
          digest: "sha256:d",
          deduped: false,
        });
      },
    );
    expect(deleted).toBe(1);
  });

  test("discardUncommittedBlobPut skips a deduped or null put", async () => {
    let deleted = 0;
    await withMocks(
      {
        blobStore: {
          delete: async () => {
            deleted += 1;
          },
        },
      },
      async () => {
        const { discardUncommittedBlobPut } = await import("./blobs");
        await discardUncommittedBlobPut(createTestRegistryContext(), {
          digest: "sha256:d",
          deduped: true,
        });
        await discardUncommittedBlobPut(createTestRegistryContext(), null);
      },
    );
    expect(deleted).toBe(0);
  });

  test("deleteUnreferencedCasBlob reclaims a pending-delete blob", async () => {
    let deleted = 0;
    await withMocks(
      {
        blobStore: {
          delete: async () => {
            deleted += 1;
          },
        },
        rowsByCall: [[{ digest: "sha256:d" }]], // delete blobs returning
      },
      async () => {
        const { deleteUnreferencedCasBlob } = await import("./blobs");
        await deleteUnreferencedCasBlob(createTestRegistryContext(), "sha256:d");
      },
    );
    expect(deleted).toBe(1);
  });
});

describe("incrementBlobRefCountTx + commitUploadedBlobRefTx", () => {
  afterEach(() => mock.restore());

  test("incrementBlobRefCountTx issues a scoped refCount bump", async () => {
    await withMocks({ rowsByCall: [[]] }, async ({ tx, calls }) => {
      const { incrementBlobRefCountTx } = await import("./blobs");
      await incrementBlobRefCountTx(tx, "sha256:d");
      expect(calls.map((c) => c.op)).toContain("update");
    });
  });

  test("commitUploadedBlobRefTx locks the digest then commits the ref", async () => {
    const stored = await withMocks(
      {
        rowsByCall: [
          [{ used: 0, max: null }], // lockOrgQuotaTx
          [], // orgAlreadyReferences: none
          [{ digest: "sha256:d" }], // ensureActiveBlobTx insert
          [{ id: "ref_1" }], // insertBlobRefTx created
        ],
      },
      async ({ tx }) => {
        const { commitUploadedBlobRefTx } = await import("./blobs");
        return commitUploadedBlobRefTx(
          tx,
          createTestRegistryContext(),
          { digest: "sha256:d", size: 5, deduped: false },
          { kind: "k", scope: "s" },
        );
      },
    );
    expect(stored).toMatchObject({ blobRefId: "ref_1", refCreated: true });
  });
});

describe("sweepUnreferencedCasBlobs", () => {
  afterEach(() => mock.restore());

  test("reclaims each candidate and counts the deletions", async () => {
    // execute #1 lists candidates; each reclaim tx: lockDigest (execute), delete returns digest.
    await withMocks(
      {
        executeRows: [[{ digest: "sha256:a" }, { digest: "sha256:b" }], [], []],
        // delete().returning() resolves to a deleted row for each reclaim.
        rowsByCall: [[{ digest: "sha256:a" }], [{ digest: "sha256:b" }]],
      },
      async () => {
        const { sweepUnreferencedCasBlobs } = await import("./blobs");
        const result = await sweepUnreferencedCasBlobs({ limit: 10, graceMs: 1000 });
        expect(result.candidates).toBe(2);
        expect(result.reclaimed).toBe(2);
      },
    );
  });
});
