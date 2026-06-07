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

describe("loadUpstream", () => {
  afterEach(() => mock.restore());

  test("returns the highest-priority upstream row", async () => {
    const row = await withFakeDb(
      [[{ url: "https://registry.npmjs.org", credentials: null, cacheTtlSeconds: 300 }]],
      async (calls) => {
        const { loadUpstream } = await import("./upstreams");
        const r = await loadUpstream("repo_1");
        // priority-ascending order + single-row limit.
        expect(calls.map((c) => c.op)).toContain("orderBy");
        expect(calls.map((c) => c.op)).toContain("limit");
        return r;
      },
    );
    expect(row).toEqual({
      url: "https://registry.npmjs.org",
      credentials: null,
      cacheTtlSeconds: 300,
    });
  });

  test("returns null when the repo has no upstream", async () => {
    const row = await withFakeDb([[]], async () => {
      const { loadUpstream } = await import("./upstreams");
      return loadUpstream("repo_1");
    });
    expect(row).toBeNull();
  });
});

describe("addUpstream", () => {
  afterEach(() => mock.restore());

  test("inserts the upstream with the given priority", async () => {
    await withFakeDb([[]], async (calls) => {
      const { addUpstream } = await import("./upstreams");
      await addUpstream("repo_1", "https://example.test", 3);
      const values = calls.find((c) => c.op === "values");
      expect(values?.args[0]).toEqual({
        repositoryId: "repo_1",
        url: "https://example.test",
        priority: 3,
      });
    });
  });

  test("defaults the priority to 0", async () => {
    await withFakeDb([[]], async (calls) => {
      const { addUpstream } = await import("./upstreams");
      await addUpstream("repo_1", "https://example.test");
      const values = calls.find((c) => c.op === "values");
      expect(values?.args[0]).toMatchObject({ priority: 0 });
    });
  });
});
