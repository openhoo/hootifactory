import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  adjustArtifactsUsedTx,
  adjustStorageUsedTx,
  assertArtifactQuotaRowAllows,
  assertStorageQuotaRowAllows,
  lockOrgQuotaTx,
  orgAlreadyReferencesDigestTx,
} from "./quota";

/** Chainable, awaitable tx stub resolving to the configured rows in call order. */
function fakeTx(rowsByCall: unknown[][] = []) {
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

describe("assertStorageQuotaRowAllows", () => {
  test("allows writes when there is no row or no max", () => {
    expect(() => assertStorageQuotaRowAllows(null, 100)).not.toThrow();
    expect(() => assertStorageQuotaRowAllows({ used: 10, max: null }, 100)).not.toThrow();
  });

  test("allows a write that fits within the cap", () => {
    expect(() => assertStorageQuotaRowAllows({ used: 10, max: 100 }, 90)).not.toThrow();
  });

  test("throws quotaExceeded when the write would overflow the cap", () => {
    expect(() => assertStorageQuotaRowAllows({ used: 10, max: 100 }, 91)).toThrow();
  });
});

describe("assertArtifactQuotaRowAllows", () => {
  test("allows writes with no row, no cap, or within the cap", () => {
    expect(() => assertArtifactQuotaRowAllows(null, 1)).not.toThrow();
    expect(() =>
      assertArtifactQuotaRowAllows({ usedArtifacts: 1, maxArtifacts: null }, 5),
    ).not.toThrow();
    expect(() =>
      assertArtifactQuotaRowAllows({ usedArtifacts: 4, maxArtifacts: 5 }, 1),
    ).not.toThrow();
  });

  test("throws when the artifact cap would be exceeded", () => {
    expect(() => assertArtifactQuotaRowAllows({ usedArtifacts: 5, maxArtifacts: 5 }, 1)).toThrow();
  });
});

describe("transaction-scoped quota helpers", () => {
  test("lockOrgQuotaTx returns the locked row or null", async () => {
    const { builder } = fakeTx([[{ used: 1, max: 10, usedArtifacts: 0, maxArtifacts: 5 }]]);
    await expect(lockOrgQuotaTx(builder as any, "org_1")).resolves.toMatchObject({ used: 1 });
    const { builder: empty } = fakeTx([[]]);
    await expect(lockOrgQuotaTx(empty as any, "org_1")).resolves.toBeNull();
  });

  test("orgAlreadyReferencesDigestTx reports whether a ref row exists", async () => {
    const { builder } = fakeTx([[{ id: "ref_1" }]]);
    await expect(orgAlreadyReferencesDigestTx(builder as any, "org_1", "sha256:x")).resolves.toBe(
      true,
    );
    const { builder: none } = fakeTx([[]]);
    await expect(orgAlreadyReferencesDigestTx(none as any, "org_1", "sha256:x")).resolves.toBe(
      false,
    );
  });

  test("adjust helpers issue a clamped GREATEST update", async () => {
    const { builder, calls } = fakeTx([[]]);
    await adjustStorageUsedTx(builder as any, "org_1", -50);
    await adjustArtifactsUsedTx(builder as any, "org_1", 1);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(2);
    expect(calls.filter((c) => c.op === "set")).toHaveLength(2);
  });
});

describe("assertStorageQuota", () => {
  afterEach(() => mock.restore());

  async function withQuotaRow<T>(rows: unknown[], run: () => Promise<T>): Promise<T> {
    const real = await import("@hootifactory/db");
    const { builder } = fakeTx([rows]);
    await mock.module("@hootifactory/db", () => ({ ...real, db: builder }));
    return run();
  }

  test("passes when the org's storage usage stays under the cap", async () => {
    await withQuotaRow([{ used: 10, max: 100 }], async () => {
      const { assertStorageQuota } = await import("./quota");
      const ctx = createTestRegistryContext();
      await expect(assertStorageQuota(ctx, 50)).resolves.toBeUndefined();
    });
  });

  test("throws quotaExceeded when the org's storage usage would overflow", async () => {
    await withQuotaRow([{ used: 90, max: 100 }], async () => {
      const { assertStorageQuota } = await import("./quota");
      const ctx = createTestRegistryContext();
      await expect(assertStorageQuota(ctx, 50)).rejects.toThrow();
    });
  });
});
