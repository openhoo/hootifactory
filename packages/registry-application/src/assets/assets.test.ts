import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";

/**
 * A chainable, awaitable drizzle stub. Every builder method is recorded and
 * returns the same chainable proxy; awaiting the proxy (or its `.then`) resolves
 * to the configured `rows`. This lets the eager `await db...` query helpers run
 * with no real database while still asserting the operations they issue.
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
  return { builder, calls, ops: () => calls.map((c) => c.op) };
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

describe("registry asset writes", () => {
  afterEach(() => mock.restore());

  test("upsertRegistryAsset returns the inserted row and defaults optional fields", async () => {
    const row = await withFakeDb([[{ id: "asset_1", role: "npm_tarball" }]], async (calls) => {
      const { upsertRegistryAsset } = await import("./assets");
      const ctx = createTestRegistryContext();
      const result = await upsertRegistryAsset(ctx, {
        digest: "sha256:abc",
        role: "npm_tarball",
      });
      // Insert was issued and an onConflictDoUpdate clause was attached.
      expect(calls.map((c) => c.op)).toContain("insert");
      expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
      expect(calls.map((c) => c.op)).toContain("returning");
      return result;
    });
    expect(row as unknown).toEqual({ id: "asset_1", role: "npm_tarball" });
  });

  test("upsertRegistryAsset throws when no row is returned", async () => {
    await withFakeDb([[]], async () => {
      const { upsertRegistryAsset } = await import("./assets");
      const ctx = createTestRegistryContext();
      await expect(
        upsertRegistryAsset(ctx, { digest: "sha256:abc", role: "npm_tarball" }),
      ).rejects.toThrow("failed to upsert registry asset");
    });
  });
});

describe("registry asset reads", () => {
  afterEach(() => mock.restore());

  test("findRegistryAssetByScope returns the first matching row or null", async () => {
    const found = await withFakeDb([[{ id: "a1", role: "r", scope: "s" }]], async () => {
      const { findRegistryAssetByScope } = await import("./assets");
      const ctx = createTestRegistryContext();
      return findRegistryAssetByScope(ctx, { role: "r", scope: "s" });
    });
    expect(found as unknown).toEqual({ id: "a1", role: "r", scope: "s" });

    const missing = await withFakeDb([[]], async () => {
      const { findRegistryAssetByScope } = await import("./assets");
      const ctx = createTestRegistryContext();
      return findRegistryAssetByScope(ctx, { role: "r", scope: "s", includeDeleted: true });
    });
    expect(missing).toBeNull();
  });

  test("listRegistryAssetsForRepository returns assets plus a total count by default", async () => {
    // First resolved query is the count() read, second is the assets read (Promise.all order).
    const result = await withFakeDb([[{ value: 3 }], [{ id: "a1" }, { id: "a2" }]], async () => {
      const { listRegistryAssetsForRepository } = await import("./assets");
      return listRegistryAssetsForRepository("repo_1", { packageId: "pkg_1", limit: 10 });
    });
    expect(result.assets).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  test("listRegistryAssetsForRepository skips the count read when withTotal is false", async () => {
    const result = await withFakeDb([[{ id: "a1" }]], async (calls) => {
      const { listRegistryAssetsForRepository } = await import("./assets");
      const r = await listRegistryAssetsForRepository("repo_1", { withTotal: false });
      // Exactly one select read (the assets query); no separate count() aggregate.
      expect(calls.filter((c) => c.op === "select")).toHaveLength(1);
      return r;
    });
    expect(result as unknown).toEqual({ assets: [{ id: "a1" }] });
    expect("total" in result).toBe(false);
  });

  test("listRegistryAssets delegates to the repository read using the context repo id", async () => {
    const result = await withFakeDb([[{ value: 0 }], []], async () => {
      const { listRegistryAssets } = await import("./assets");
      const ctx = createTestRegistryContext();
      return listRegistryAssets(ctx, { digest: "sha256:x", packageVersionId: "pv_1" });
    });
    expect(result).toEqual({ assets: [], total: 0 });
  });

  test("deleteRegistryAssetRef issues a soft-delete update scoped to the ref", async () => {
    await withFakeDb([[]], async (calls) => {
      const { deleteRegistryAssetRef } = await import("./assets");
      const ctx = createTestRegistryContext();
      await deleteRegistryAssetRef(ctx, { digest: "sha256:x", scope: "s", role: "r" });
      expect(calls.map((c) => c.op)).toContain("update");
      expect(calls.map((c) => c.op)).toContain("set");
      expect(calls.map((c) => c.op)).toContain("where");
    });
  });
});
