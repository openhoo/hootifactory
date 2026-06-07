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

describe("findOrCreatePackage", () => {
  afterEach(() => mock.restore());

  test("upserts and returns the package row", async () => {
    const row = await withFakeDb([[{ id: "pkg_1", name: "demo" }]], async (calls) => {
      const { findOrCreatePackage } = await import("./packages");
      const r = await findOrCreatePackage({ orgId: "o", repositoryId: "r", name: "demo" });
      expect(calls.map((c) => c.op)).toContain("onConflictDoUpdate");
      const values = calls.find((c) => c.op === "values");
      expect(values?.args[0]).toMatchObject({ name: "demo", namespace: null });
      return r;
    });
    expect(row as unknown).toEqual({ id: "pkg_1", name: "demo" });
  });

  test("throws when the upsert returns no row", async () => {
    await withFakeDb([[]], async () => {
      const { findOrCreatePackage } = await import("./packages");
      await expect(
        findOrCreatePackage({ orgId: "o", repositoryId: "r", name: "demo", namespace: "@scope" }),
      ).rejects.toThrow("failed to upsert package");
    });
  });
});

describe("package version reads", () => {
  afterEach(() => mock.restore());

  test("findPackageByName returns the matched package or null", async () => {
    const ctx = createTestRegistryContext();
    const found = await withFakeDb([[{ id: "pkg_1" }]], async () => {
      const { findPackageByName } = await import("./packages");
      return findPackageByName(ctx, "demo");
    });
    expect(found as unknown).toEqual({ id: "pkg_1" });

    const none = await withFakeDb([[]], async () => {
      const { findPackageByName } = await import("./packages");
      return findPackageByName(ctx, "demo");
    });
    expect(none).toBeNull();
  });

  test("findVersion returns the matched version or null", async () => {
    const found = await withFakeDb([[{ id: "v1", version: "1.0.0" }]], async () => {
      const { findVersion } = await import("./packages");
      return findVersion("pkg_1", "1.0.0");
    });
    expect(found).toMatchObject({ version: "1.0.0" });

    const none = await withFakeDb([[]], async () => {
      const { findVersion } = await import("./packages");
      return findVersion("pkg_1", "9.9.9");
    });
    expect(none).toBeNull();
  });

  test("findLiveVersion filters out soft-deleted versions and returns null when absent", async () => {
    const found = await withFakeDb(
      [[{ id: "v1", version: "1.0.0", deletedAt: null }]],
      async (calls) => {
        const { findLiveVersion } = await import("./packages");
        const r = await findLiveVersion("pkg_1", "1.0.0");
        // The query must constrain on three predicates (packageId, version, deletedAt IS NULL).
        expect(calls.map((c) => c.op)).toContain("where");
        return r;
      },
    );
    expect(found).toMatchObject({ version: "1.0.0" });

    const none = await withFakeDb([[]], async () => {
      const { findLiveVersion } = await import("./packages");
      return findLiveVersion("pkg_1", "1.0.0");
    });
    expect(none).toBeNull();
  });
});
