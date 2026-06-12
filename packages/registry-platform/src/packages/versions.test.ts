import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

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
        return (cb: (tx: unknown) => Promise<unknown>) => {
          calls.push({ op: "transaction", args: [] });
          return cb(builder);
        };
      }
      if (prop === "execute") return async () => [];
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
    put?: (...a: unknown[]) => Promise<unknown>;
    stat?: (...a: unknown[]) => Promise<unknown>;
    delete?: (...a: unknown[]) => Promise<void>;
    scannerEnabled?: boolean;
  },
  run: (calls: { op: string; args: unknown[] }[]) => Promise<T>,
): Promise<T> {
  const realConfig = await import("@hootifactory/config");
  const realDb = await import("@hootifactory/db");
  const realStorage = await import("@hootifactory/storage");
  const { builder, calls } = fakeDb(opts.rowsByCall ?? []);
  await mock.module("@hootifactory/config", () => ({
    ...realConfig,
    env: {
      ...realConfig.env,
      SCANNER_ENABLED: opts.scannerEnabled ?? realConfig.env.SCANNER_ENABLED,
    },
  }));
  await mock.module("@hootifactory/db", () => ({ ...realDb, db: builder }));
  await mock.module("@hootifactory/storage", () => ({
    ...realStorage,
    blobStore: {
      blobKey: (d: string) => `blobs/${d}`,
      put:
        opts.put ??
        (async (data: Uint8Array, digest: string) => ({
          digest,
          size: data.byteLength,
          deduped: false,
        })),
      stat: opts.stat ?? (async () => ({ size: 5 })),
      delete: opts.delete ?? (async () => {}),
    },
  }));
  return run(calls);
}

describe("publisherOf", () => {
  test("derives publisher columns from the principal kind", async () => {
    const { publisherOf } = await import("./versions");
    expect(publisherOf({ principal: { kind: "user", userId: "u1" } } as never)).toEqual({
      publishedByUserId: "u1",
      publishedByTokenId: null,
    });
    expect(
      publisherOf({ principal: { kind: "token", ownerUserId: "u2", tokenId: "t1" } } as never),
    ).toEqual({ publishedByUserId: "u2", publishedByTokenId: "t1" });
    expect(publisherOf({ principal: { kind: "anonymous" } } as never)).toEqual({
      publishedByUserId: null,
      publishedByTokenId: null,
    });
  });
});

describe("upsertPackageVersion", () => {
  afterEach(() => mock.restore());

  test("charges an artifact for a new version and returns the id", async () => {
    // existing version (none) -> lock quota -> upsert returns row.
    const id = await withMocks(
      {
        rowsByCall: [
          [],
          [{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }],
          [{ id: "v1" }],
        ],
      },
      async (calls) => {
        const { upsertPackageVersion } = await import("./versions");
        const r = await upsertPackageVersion(createTestRegistryContext(), {
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 5,
        });
        expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
        return r;
      },
    );
    expect(id).toBe("v1");
  });

  test("does not re-charge when the version already exists and is live", async () => {
    const id = await withMocks(
      {
        rowsByCall: [
          [{ id: "v1", deletedAt: null }],
          [{ used: 0, max: null, usedArtifacts: 99, maxArtifacts: 100 }],
          [{ id: "v1" }],
        ],
      },
      async () => {
        const { upsertPackageVersion } = await import("./versions");
        return upsertPackageVersion(createTestRegistryContext(), {
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 5,
        });
      },
    );
    expect(id).toBe("v1");
  });

  test("throws when the upsert returns no row", async () => {
    await withMocks(
      { rowsByCall: [[], [{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }], []] },
      async () => {
        const { upsertPackageVersion } = await import("./versions");
        await expect(
          upsertPackageVersion(createTestRegistryContext(), {
            packageId: "p1",
            version: "1.0.0",
            metadata: {},
            sizeBytes: 5,
          }),
        ).rejects.toThrow("failed to upsert package version");
      },
    );
  });
});

describe("createPackageVersion", () => {
  afterEach(() => mock.restore());

  test("returns the new id when the insert wins", async () => {
    const id = await withMocks(
      {
        rowsByCall: [
          [{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }],
          [{ id: "v1" }],
        ],
      },
      async () => {
        const { createPackageVersion } = await import("./versions");
        return createPackageVersion(createTestRegistryContext(), {
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 5,
        });
      },
    );
    expect(id).toBe("v1");
  });

  test("returns null when the version already exists (conflict, no row)", async () => {
    const id = await withMocks(
      { rowsByCall: [[{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }], []] },
      async () => {
        const { createPackageVersion } = await import("./versions");
        return createPackageVersion(createTestRegistryContext(), {
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 5,
        });
      },
    );
    expect(id).toBeNull();
  });
});

describe("commitVersionOrReleaseBlob", () => {
  afterEach(() => mock.restore());

  test("records scan outbox intent in the version transaction on success", async () => {
    let recordedScan: unknown;
    let recordedTx: unknown;
    const result = await withMocks(
      {
        scannerEnabled: true,
        rowsByCall: [
          [{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }],
          [{ id: "v1" }],
        ],
      },
      async () => {
        await mock.module("../runtime/scan-outbox", () => ({
          recordArtifactScanOutbox: async (
            _repo: unknown,
            input: unknown,
            _captureTelemetry: unknown,
            tx: unknown,
          ) => {
            recordedScan = input;
            recordedTx = tx;
            return { artifactId: "artifact_1" };
          },
        }));
        const { commitVersionOrReleaseBlob } = await import("./versions");
        const ctx = createTestRegistryContext();
        const committed = await commitVersionOrReleaseBlob(ctx, {
          stored: {
            digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            size: 5,
            deduped: false,
            refCreated: true,
            blobRefId: "b1",
          },
          kind: "npm_tarball",
          scope: "demo@1.0.0",
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 5,
          scan: { name: "demo", version: "1.0.0", mediaType: "application/octet-stream" },
        });
        return committed;
      },
    );
    expect(result).toEqual({ versionId: "v1" });
    expect(recordedScan).toEqual({
      digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      name: "demo",
      version: "1.0.0",
      mediaType: "application/octet-stream",
    });
    expect(recordedTx).toBeDefined();
  });

  test("releases the created blob ref and reports a conflict when the version exists", async () => {
    // createPackageVersion: lock quota row, conflict (no row). Then releaseBlobRef
    // tx: lockDigest (execute), delete ref returns row, blobs read, org-refs read.
    const result = await withMocks(
      {
        rowsByCall: [
          [{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }], // create lock quota
          [], // create conflict, no row
          [{ id: "ref_1" }], // releaseBlobRef delete returning
          [{ refCount: 0, size: 5 }], // releaseBlobRef blob read
          [], // orgAlreadyReferencesDigestTx: none
        ],
      },
      async () => {
        const { commitVersionOrReleaseBlob } = await import("./versions");
        const ctx = createTestRegistryContext();
        ctx.enqueueScan = async () => {
          throw new Error("scan should not be enqueued on conflict");
        };
        return commitVersionOrReleaseBlob(ctx, {
          stored: {
            digest: "sha256:d",
            size: 5,
            deduped: false,
            refCreated: true,
            blobRefId: "b1",
          },
          kind: "npm_tarball",
          scope: "demo@1.0.0",
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 5,
          scan: {},
        });
      },
    );
    expect(result).toEqual({ conflict: true });
  });
});

describe("setDistTag", () => {
  afterEach(() => mock.restore());

  test("upserts the tag pointer", async () => {
    await withMocks({ rowsByCall: [[]] }, async (calls) => {
      const { setDistTag } = await import("./versions");
      await setDistTag("p1", "latest", "v1");
      const values = calls.find((c) => c.op === "values");
      expect(values?.args[0]).toEqual({ packageId: "p1", tag: "latest", versionId: "v1" });
      expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
    });
  });
});

describe("upsertPackageVersionWithBlobRef", () => {
  afterEach(() => mock.restore());

  test("a failed CAS put aborts before any transaction is opened", async () => {
    // The S3 put now happens BEFORE db.transaction: when it fails, no transaction
    // (and no advisory lock) must ever have been opened.
    await withMocks(
      {
        put: async () => {
          throw new Error("s3 down");
        },
      },
      async (calls) => {
        const { upsertPackageVersionWithBlobRef } = await import("./versions");
        await expect(
          upsertPackageVersionWithBlobRef(createTestRegistryContext(), {
            packageId: "p1",
            version: "1.0.0",
            metadata: {},
            sizeBytes: 3,
            blob: { data: new Uint8Array([1, 2, 3]), kind: "npm_tarball", scope: "demo@1.0.0" },
          }),
        ).rejects.toThrow("s3 down");
        expect(calls.map((c) => c.op)).not.toContain("transaction");
      },
    );
  });

  test("discards the staged blob when the CAS object vanished before the tx", async () => {
    // stat() returning null under the digest lock means the staged object was
    // GC'd between the put and the tx: the upsert must fail and discard the put.
    let discarded = 0;
    await withMocks(
      {
        stat: async () => null,
        delete: async () => {
          discarded += 1;
        },
        // discardUncommittedBlobPut tx: blobs select finds no recorded row.
        rowsByCall: [[]],
      },
      async () => {
        const { upsertPackageVersionWithBlobRef } = await import("./versions");
        await expect(
          upsertPackageVersionWithBlobRef(createTestRegistryContext(), {
            packageId: "p1",
            version: "1.0.0",
            metadata: {},
            sizeBytes: 3,
            blob: { data: new Uint8Array([1, 2, 3]), kind: "npm_tarball", scope: "demo@1.0.0" },
          }),
        ).rejects.toThrow();
      },
    );
    expect(discarded).toBe(1);
  });

  test("stores the blob, inserts a ref, and records the version", async () => {
    const result = await withMocks(
      {
        rowsByCall: [
          [{ used: 0, max: null, usedArtifacts: 0, maxArtifacts: null }], // lockOrgQuotaTx
          [], // existing version: none
          [], // orgAlreadyReferencesDigestTx for put.digest: none
          [{ digest: "sha256:d" }], // ensureActiveBlobTx insert created
          [{ id: "ref_1" }], // insertBlobRefTx created
          [{ id: "v1" }], // packageVersions upsert returning
        ],
      },
      async () => {
        const { upsertPackageVersionWithBlobRef } = await import("./versions");
        return upsertPackageVersionWithBlobRef(createTestRegistryContext(), {
          packageId: "p1",
          version: "1.0.0",
          metadata: {},
          sizeBytes: 3,
          blob: { data: new Uint8Array([1, 2, 3]), kind: "npm_tarball", scope: "demo@1.0.0" },
        });
      },
    );
    expect(result.versionId).toBe("v1");
    expect(result.stored).toMatchObject({ blobRefId: "ref_1", refCreated: true, size: 3 });
  });
});
