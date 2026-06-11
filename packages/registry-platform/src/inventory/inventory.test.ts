import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * A chainable, awaitable drizzle stub: each builder method is recorded and
 * returns the chainable proxy, and awaiting it resolves to the next configured
 * row batch (in call order). Exercises the eager read helpers with no database.
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

describe("inventory counts", () => {
  afterEach(() => mock.restore());

  test("count helpers read the aggregate value and fall back to 0", async () => {
    await withFakeDb([[{ value: 5 }]], async () => {
      const { countRepositoryPackages } = await import("./inventory");
      expect(await countRepositoryPackages("repo_1")).toBe(5);
    });
    await withFakeDb([[]], async () => {
      const { countLivePackageVersions } = await import("./inventory");
      expect(await countLivePackageVersions("pkg_1")).toBe(0);
    });
    await withFakeDb([[{ value: 9 }]], async () => {
      const { countRepositoryArtifacts } = await import("./inventory");
      expect(await countRepositoryArtifacts("repo_1")).toBe(9);
    });
    await withFakeDb([[{ value: 2 }]], async () => {
      const { countArtifactFindings } = await import("./inventory");
      expect(await countArtifactFindings("art_1", { severity: "high" })).toBe(2);
    });
  });
});

describe("inventory single-row reads", () => {
  afterEach(() => mock.restore());

  test("getPackageWithRepository returns the joined row or null", async () => {
    const row = await withFakeDb([[{ pkg: { id: "p1" }, repo: { id: "r1" } }]], async () => {
      const { getPackageWithRepository } = await import("./inventory");
      return getPackageWithRepository("p1");
    });
    expect(row as unknown).toEqual({ pkg: { id: "p1" }, repo: { id: "r1" } });

    const none = await withFakeDb([[]], async () => {
      const { getArtifactWithRepository } = await import("./inventory");
      return getArtifactWithRepository("art_x");
    });
    expect(none).toBeNull();
  });
});

describe("inventory paginated reads", () => {
  afterEach(() => mock.restore());

  test("listRepositoryPackageSummaries applies limit/offset only when paged", async () => {
    const paged = await withFakeDb(
      [[{ id: "p1", name: "a", latestVersion: "1.0.0" }]],
      async (calls) => {
        const { listRepositoryPackageSummaries } = await import("./inventory");
        const r = await listRepositoryPackageSummaries("repo_1", { limit: 10, offset: 5 });
        expect(calls.map((c) => c.op)).toContain("limit");
        expect(calls.map((c) => c.op)).toContain("offset");
        return r;
      },
    );
    expect(paged).toEqual([{ id: "p1", name: "a", latestVersion: "1.0.0" }]);

    await withFakeDb([[]], async (calls) => {
      const { listRepositoryPackageSummaries } = await import("./inventory");
      await listRepositoryPackageSummaries("repo_1");
      expect(calls.map((c) => c.op)).not.toContain("limit");
    });
  });

  test("listLivePackageVersionSummaries returns rows with and without paging", async () => {
    const rows = await withFakeDb(
      [[{ version: "1.0.0", sizeBytes: 10, createdAt: new Date() }]],
      async () => {
        const { listLivePackageVersionSummaries } = await import("./inventory");
        return listLivePackageVersionSummaries("pkg_1", { limit: 1, offset: 0 });
      },
    );
    expect(rows).toHaveLength(1);

    await withFakeDb([[]], async () => {
      const { listLivePackageVersionSummaries } = await import("./inventory");
      expect(await listLivePackageVersionSummaries("pkg_1")).toEqual([]);
    });
  });

  test("listRepositoryArtifactSummaries returns rows with and without paging", async () => {
    await withFakeDb([[{ id: "a1", digest: "sha256:x" }]], async () => {
      const { listRepositoryArtifactSummaries } = await import("./inventory");
      expect(await listRepositoryArtifactSummaries("repo_1", { limit: 5, offset: 0 })).toHaveLength(
        1,
      );
    });
    await withFakeDb([[]], async () => {
      const { listRepositoryArtifactSummaries } = await import("./inventory");
      expect(await listRepositoryArtifactSummaries("repo_1")).toEqual([]);
    });
  });

  test("listArtifactFindings paginates only when a limit is supplied", async () => {
    await withFakeDb([[{ vulnId: "CVE-1" }]], async (calls) => {
      const { listArtifactFindings } = await import("./inventory");
      await listArtifactFindings("art_1", { limit: 10, offset: 0, severity: "critical" });
      expect(calls.map((c) => c.op)).toContain("offset");
    });
    await withFakeDb([[]], async (calls) => {
      const { listArtifactFindings } = await import("./inventory");
      await listArtifactFindings("art_1", { severity: "low" });
      expect(calls.map((c) => c.op)).not.toContain("offset");
    });
  });
});
