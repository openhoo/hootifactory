import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

/**
 * Chainable, awaitable drizzle stub. Builder methods record + return the chain;
 * awaiting resolves to the next configured row batch in call order. `execute`
 * returns the next batch wrapped so rowsFromExecute can read it.
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

async function withFakeDb<T>(
  rowsByCall: unknown[][],
  run: (calls: { op: string; args: unknown[] }[]) => Promise<T>,
  executeRows: unknown[][] = [],
): Promise<T> {
  const real = await import("@hootifactory/db");
  const { builder, calls } = fakeDb(rowsByCall, executeRows);
  await mock.module("@hootifactory/db", () => ({ ...real, db: builder }));
  return run(calls);
}

const ctx = () => createTestRegistryContext();

describe("repository package list reads", () => {
  afterEach(() => mock.restore());

  test("listRepositoryPackageNames returns the name rows", async () => {
    const rows = await withFakeDb([[{ name: "a" }, { name: "b" }]], async () => {
      const { listRepositoryPackageNames } = await import("./queries");
      return listRepositoryPackageNames(ctx());
    });
    expect(rows).toEqual([{ name: "a" }, { name: "b" }]);
  });

  test("listRepositoryPackages returns the summary rows", async () => {
    const rows = await withFakeDb([[{ id: "p1", name: "a" }]], async () => {
      const { listRepositoryPackages } = await import("./queries");
      return listRepositoryPackages(ctx());
    });
    expect(rows).toEqual([{ id: "p1", name: "a" }]);
  });
});

describe("searchRepositoryPackages", () => {
  afterEach(() => mock.restore());

  test("returns rows and the window total when the first page is non-empty", async () => {
    const result = await withFakeDb(
      [[{ id: "p1", orgId: "o", repositoryId: "r", name: "a", total: 2 }]],
      async () => {
        const { searchRepositoryPackages } = await import("./queries");
        return searchRepositoryPackages(ctx(), { text: "a", from: 0, size: 10 });
      },
    );
    expect(result.total).toBe(2);
    expect(result.packages).toEqual([{ id: "p1", orgId: "o", repositoryId: "r", name: "a" }]);
  });

  test("falls back to a count read when the page is empty", async () => {
    // First read (rows) empty, second read = count.
    const result = await withFakeDb([[], [{ value: 5 }]], async () => {
      const { searchRepositoryPackages } = await import("./queries");
      return searchRepositoryPackages(ctx(), { text: "", from: 0, size: 10 });
    });
    expect(result).toEqual({ packages: [], total: 5 });
  });

  test("coerces a string window total and rejects non-numeric junk", async () => {
    const ok = await withFakeDb(
      [[{ id: "p1", orgId: "o", repositoryId: "r", name: "a", total: "9" }]],
      async () => {
        const { searchRepositoryPackages } = await import("./queries");
        return searchRepositoryPackages(ctx(), { text: "x", from: 0, size: 10 });
      },
    );
    expect(ok.total).toBe(9);

    const junk = await withFakeDb(
      [[{ id: "p1", orgId: "o", repositoryId: "r", name: "a", total: "nope" }]],
      async () => {
        const { searchRepositoryPackages } = await import("./queries");
        return searchRepositoryPackages(ctx(), { text: "x", from: 0, size: 10 });
      },
    );
    expect(junk.total).toBe(0);
  });
});

describe("version list reads", () => {
  afterEach(() => mock.restore());

  test("listLivePackageVersionsForPackages groups rows by package and dedups ids", async () => {
    const map = await withFakeDb(
      [
        [
          { packageId: "p1", version: "1.0.0" },
          { packageId: "p1", version: "1.1.0" },
          { packageId: "p2", version: "2.0.0" },
        ],
      ],
      async () => {
        const { listLivePackageVersionsForPackages } = await import("./queries");
        return listLivePackageVersionsForPackages(["p1", "p2", "p1"], { orderByCreated: "desc" });
      },
    );
    expect(map.get("p1")).toHaveLength(2);
    expect(map.get("p2")).toHaveLength(1);
  });

  test("listLivePackageVersionsForPackages returns empty map for no ids", async () => {
    const map = await withFakeDb([[]], async () => {
      const { listLivePackageVersionsForPackages } = await import("./queries");
      return listLivePackageVersionsForPackages([]);
    });
    expect(map.size).toBe(0);
  });

  test("listPackageVersionNames returns the version-name rows", async () => {
    const rows = await withFakeDb([[{ version: "1.0.0" }]], async () => {
      const { listPackageVersionNames } = await import("./queries");
      return listPackageVersionNames("p1");
    });
    expect(rows).toEqual([{ version: "1.0.0" }]);
  });

  test("listLivePackageVersionFingerprints returns version/updatedAt rows", async () => {
    const now = new Date();
    const rows = await withFakeDb([[{ version: "1.0.0", updatedAt: now }]], async () => {
      const { listLivePackageVersionFingerprints } = await import("./queries");
      return listLivePackageVersionFingerprints("p1");
    });
    expect(rows).toEqual([{ version: "1.0.0", updatedAt: now }]);
  });
});

describe("dist-tag reads", () => {
  afterEach(() => mock.restore());

  test("listLiveDistTags maps tag -> version", async () => {
    const tags = await withFakeDb(
      [
        [
          { tag: "latest", version: "1.0.0" },
          { tag: "beta", version: "1.1.0-beta" },
        ],
      ],
      async () => {
        const { listLiveDistTags } = await import("./queries");
        return listLiveDistTags("p1");
      },
    );
    expect(tags).toEqual({ latest: "1.0.0", beta: "1.1.0-beta" });
  });

  test("listLiveDistTagsForPackages groups tag maps by package", async () => {
    const map = await withFakeDb(
      [[{ packageId: "p1", tag: "latest", version: "1.0.0" }]],
      async () => {
        const { listLiveDistTagsForPackages } = await import("./queries");
        return listLiveDistTagsForPackages(["p1", "p2"]);
      },
    );
    expect(map.get("p1")).toEqual({ latest: "1.0.0" });
    expect(map.get("p2")).toEqual({});
  });

  test("listLiveDistTagsForPackages short-circuits for no ids", async () => {
    const map = await withFakeDb([[]], async () => {
      const { listLiveDistTagsForPackages } = await import("./queries");
      return listLiveDistTagsForPackages([]);
    });
    expect(map.size).toBe(0);
  });
});

describe("dist-tag writes + metadata", () => {
  afterEach(() => mock.restore());

  test("deleteDistTag and updatePackageLatestVersion issue scoped writes", async () => {
    await withFakeDb([[]], async (calls) => {
      const { deleteDistTag } = await import("./queries");
      await deleteDistTag("p1", "beta");
      expect(calls.map((c) => c.op)).toContain("delete");
    });
    await withFakeDb([[]], async (calls) => {
      const { updatePackageLatestVersion } = await import("./queries");
      await updatePackageLatestVersion("p1", "2.0.0");
      expect(calls.map((c) => c.op)).toContain("update");
    });
  });

  test("packageVersionExists reflects whether a row was found", async () => {
    await withFakeDb([[{ id: "v1" }]], async () => {
      const { packageVersionExists } = await import("./queries");
      expect(await packageVersionExists("p1", "1.0.0")).toBe(true);
    });
    await withFakeDb([[]], async () => {
      const { packageVersionExists } = await import("./queries");
      expect(await packageVersionExists("p1", "9.9.9")).toBe(false);
    });
  });

  test("updatePackageVersionMetadata sets size only when provided", async () => {
    await withFakeDb([[]], async (calls) => {
      const { updatePackageVersionMetadata } = await import("./queries");
      await updatePackageVersionMetadata("v1", { a: 1 }, { sizeBytes: 42 });
      const set = calls.find((c) => c.op === "set");
      expect(set?.args[0]).toMatchObject({ metadata: { a: 1 }, sizeBytes: 42 });
    });
    await withFakeDb([[]], async (calls) => {
      const { updatePackageVersionMetadata } = await import("./queries");
      await updatePackageVersionMetadata("v1", { a: 1 });
      const set = calls.find((c) => c.op === "set");
      expect("sizeBytes" in (set?.args[0] as object)).toBe(false);
    });
  });

  test("listRepositoryVersionMetadata builds the joined read for the package scope", async () => {
    const rows = await withFakeDb(
      [[{ version: "1.0.0", metadata: {}, createdAt: new Date() }]],
      async () => {
        const { listRepositoryVersionMetadata } = await import("./queries");
        return listRepositoryVersionMetadata(ctx(), { packageId: "p1", liveOnly: false });
      },
    );
    expect(rows).toHaveLength(1);
  });

  test("listLiveVersionPublishers returns publisher rows", async () => {
    const rows = await withFakeDb([[{ id: "u1", login: "alice", name: "Alice" }]], async () => {
      const { listLiveVersionPublishers } = await import("./queries");
      return listLiveVersionPublishers("p1");
    });
    expect(rows).toEqual([{ id: "u1", login: "alice", name: "Alice" }]);
  });
});

describe("patchPackageVersion", () => {
  afterEach(() => mock.restore());

  test("applies the update when the patch reports one and the row exists", async () => {
    // tx select returns the existing row; the update write follows.
    const result = await withFakeDb(
      [[{ id: "v1", metadata: {}, deletedAt: null }], []],
      async (calls) => {
        const { patchPackageVersion } = await import("./queries");
        const r = await patchPackageVersion({
          packageId: "p1",
          version: "1.0.0",
          patch: (row) => ({
            update: { metadata: { patched: true }, sizeBytes: 10 },
            result: { ok: true, hadRow: Boolean(row) },
          }),
        });
        expect(calls.map((c) => c.op)).toContain("update");
        return r;
      },
    );
    expect(result).toEqual({ ok: true, hadRow: true });
  });

  test("skips the update when the patch reports none or the row is missing", async () => {
    const result = await withFakeDb([[]], async (calls) => {
      const { patchPackageVersion } = await import("./queries");
      const r = await patchPackageVersion({
        packageId: "p1",
        version: "9.9.9",
        patch: (row) => ({ result: { row } }),
      });
      expect(calls.map((c) => c.op)).not.toContain("update");
      return r;
    });
    expect(result).toEqual({ row: null });
  });
});

describe("listSearchPackageVersionsForPackages", () => {
  afterEach(() => mock.restore());

  test("returns an empty map for no ids", async () => {
    const map = await withFakeDb([[]], async () => {
      const { listSearchPackageVersionsForPackages } = await import("./queries");
      return listSearchPackageVersionsForPackages([], new Map());
    });
    expect(map.size).toBe(0);
  });

  test("prefers the pinned version then falls back to the latest for the rest", async () => {
    const now = new Date();
    // execute #1 = preferred rows (p1), execute #2 = fallback distinct-on (p2).
    const map = await withFakeDb([[]], async () => {
      const { listSearchPackageVersionsForPackages } = await import("./queries");
      return listSearchPackageVersionsForPackages(["p1", "p2"], new Map([["p1", "1.0.0"]]));
    }, [
      [{ packageId: "p1", version: "1.0.0", metadata: JSON.stringify({ a: 1 }), createdAt: now }],
      [{ packageId: "p2", version: "2.0.0", metadata: null, createdAt: now }],
    ]);
    expect(map.get("p1")).toMatchObject({ version: "1.0.0", metadata: { a: 1 } });
    expect(map.get("p2")).toMatchObject({ version: "2.0.0", metadata: null });
  });
});
