import { afterEach, describe, expect, mock, test } from "bun:test";

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

describe("createRepository", () => {
  afterEach(() => mock.restore());

  test("computes the mount + storage prefix and returns the inserted row", async () => {
    const repo = await withFakeDb(
      [[{ id: "repo_1", mountPath: "npm/acme/packages" }]],
      async (calls) => {
        const { createRepository } = await import("./repositories");
        const r = await createRepository({
          orgId: "org_1",
          orgSlug: "acme",
          name: "packages",
          moduleId: "npm",
          module: { mountSegment: "npm" },
        });
        const insert = calls.find((c) => c.op === "values");
        expect(insert?.args[0]).toMatchObject({
          orgId: "org_1",
          name: "packages",
          mountPath: "npm/acme/packages",
          storagePrefix: "org_1/packages",
          kind: "hosted",
          visibility: "private",
        });
        return r;
      },
    );
    expect(repo).toMatchObject({ id: "repo_1" });
  });

  test("throws when the insert returns no row", async () => {
    await withFakeDb([[]], async () => {
      const { createRepository } = await import("./repositories");
      await expect(
        createRepository({
          orgId: "o",
          orgSlug: "s",
          name: "n",
          moduleId: "npm",
          module: { mountSegment: "npm" },
        }),
      ).rejects.toThrow("failed to create repository");
    });
  });
});

describe("repository reads", () => {
  afterEach(() => mock.restore());

  test("getRepositoryById returns the first row or null", async () => {
    const found = await withFakeDb([[{ id: "r1" }]], async () => {
      const { getRepositoryById } = await import("./repositories");
      return getRepositoryById("r1");
    });
    expect(found).toEqual({ id: "r1" });

    const none = await withFakeDb([[]], async () => {
      const { getRepositoryById } = await import("./repositories");
      return getRepositoryById("missing");
    });
    expect(none).toBeNull();
  });

  test("countRepositoriesForOrg reads the aggregate count", async () => {
    await withFakeDb([[{ value: 7 }]], async () => {
      const { countRepositoriesForOrg } = await import("./repositories");
      expect(await countRepositoriesForOrg("org_1")).toBe(7);
    });
    await withFakeDb([[]], async () => {
      const { countRepositoriesForOrg } = await import("./repositories");
      expect(await countRepositoriesForOrg("org_1")).toBe(0);
    });
  });

  test("listRepositoriesForOrg applies paging only when requested", async () => {
    await withFakeDb([[{ id: "r1" }, { id: "r2" }]], async (calls) => {
      const { listRepositoriesForOrg } = await import("./repositories");
      expect(await listRepositoriesForOrg("org_1", { limit: 10, offset: 0 })).toHaveLength(2);
      expect(calls.map((c) => c.op)).toContain("limit");
    });
    await withFakeDb([[]], async (calls) => {
      const { listRepositoriesForOrg } = await import("./repositories");
      await listRepositoriesForOrg("org_1");
      expect(calls.map((c) => c.op)).not.toContain("offset");
    });
  });
});
