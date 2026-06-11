import { describe, expect, test } from "bun:test";
import type { db, RetentionRule } from "@hootifactory/db";
import { applyDueRetentionPolicies } from "./retention-sweep";

interface PolicyRow {
  id: string;
  repositoryId: string | null;
  rules: RetentionRule;
  action: string;
}

/**
 * The sweep's only query is a single select builder chain; the fake resolves it
 * with the configured rows and captures the limit, so no test opens a real
 * connection. The retention engine itself is injected per test through the
 * deps seam (never via mock.module).
 */
function fakeDb(rows: PolicyRow[], captured: { limit?: number }): typeof db {
  const handler: ProxyHandler<(...a: unknown[]) => unknown> = {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(rows);
      }
      return (...args: unknown[]) => {
        if (prop === "limit") captured.limit = args[0] as number;
        return chain;
      };
    },
    apply() {
      return chain;
    },
  };
  const chain: any = new Proxy(() => {}, handler);
  return { select: () => chain } as unknown as typeof db;
}

function policy(overrides: Partial<PolicyRow> & { id: string }): PolicyRow {
  return { repositoryId: `repo_${overrides.id}`, rules: {}, action: "delete", ...overrides };
}

describe("applyDueRetentionPolicies", () => {
  test("applies each per-repository policy through the engine and sums pruned", async () => {
    const calls: { repositoryId: string; keepLastN: number }[] = [];
    const prunedByRepo: Record<string, number> = { repo_a: 2, repo_b: 0 };
    const result = await applyDueRetentionPolicies(
      { limit: 100 },
      {
        db: fakeDb(
          [
            policy({ id: "a", repositoryId: "repo_a", rules: { keepLastN: 5 } }),
            policy({ id: "b", repositoryId: "repo_b", rules: { keepLastN: 3 } }),
          ],
          {},
        ),
        applyRetention: async (repositoryId, keepLastN) => {
          calls.push({ repositoryId, keepLastN });
          return prunedByRepo[repositoryId] ?? 0;
        },
      },
    );
    expect(calls).toEqual([
      { repositoryId: "repo_a", keepLastN: 5 },
      { repositoryId: "repo_b", keepLastN: 3 },
    ]);
    expect(result).toEqual({ policies: 2, applied: 2, pruned: 2, skipped: 0, failed: 0 });
  });

  test("isolates a failing repository and continues the sweep", async () => {
    const applied: string[] = [];
    const result = await applyDueRetentionPolicies(
      { limit: 100 },
      {
        db: fakeDb(
          [
            policy({ id: "a", repositoryId: "repo_a", rules: { keepLastN: 1 } }),
            policy({ id: "b", repositoryId: "repo_b", rules: { keepLastN: 1 } }),
            policy({ id: "c", repositoryId: "repo_c", rules: { keepLastN: 1 } }),
          ],
          {},
        ),
        applyRetention: async (repositoryId) => {
          if (repositoryId === "repo_b") throw new Error("repo_b retention blew up");
          applied.push(repositoryId);
          return 1;
        },
      },
    );
    expect(applied).toEqual(["repo_a", "repo_c"]);
    expect(result).toEqual({ policies: 3, applied: 2, pruned: 2, skipped: 0, failed: 1 });
  });

  test("skips policies without a rule the engine supports", async () => {
    let engineCalls = 0;
    const result = await applyDueRetentionPolicies(
      { limit: 100 },
      {
        db: fakeDb(
          [
            // No keepLastN at all.
            policy({ id: "a", rules: {} }),
            // maxAgeDays is not implemented by the engine.
            policy({ id: "b", rules: { maxAgeDays: 30 } }),
            // Unknown action must not be misapplied as a delete.
            policy({ id: "c", rules: { keepLastN: 5 }, action: "archive" }),
            // keepLastN below the engine's minimum keep window.
            policy({ id: "d", rules: { keepLastN: 0 } }),
          ],
          {},
        ),
        applyRetention: async () => {
          engineCalls += 1;
          return 0;
        },
      },
    );
    expect(engineCalls).toBe(0);
    expect(result).toEqual({ policies: 4, applied: 0, pruned: 0, skipped: 4, failed: 0 });
  });

  test("bounds the policy query by the batch limit", async () => {
    const captured: { limit?: number } = {};
    await applyDueRetentionPolicies(
      { limit: 7 },
      { db: fakeDb([], captured), applyRetention: async () => 0 },
    );
    expect(captured.limit).toBe(7);
  });
});
