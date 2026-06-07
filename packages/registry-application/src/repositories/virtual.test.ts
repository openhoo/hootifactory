import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * A chainable, awaitable drizzle stub used as the transaction handle. Each call
 * resolves (when awaited) to the next configured row batch in call order.
 */
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
      // The same proxy doubles as the bare db and the transaction handle.
      if (prop === "transaction") {
        return (cb: (tx: unknown) => Promise<unknown>) => cb(builder);
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
  const { builder, calls } = fakeTx(rowsByCall);
  await mock.module("@hootifactory/db", () => ({ ...real, db: builder }));
  return run(calls);
}

describe("loadVirtualMembers", () => {
  afterEach(() => mock.restore());

  test("returns member repos in resolution order", async () => {
    const repos = await withFakeDb(
      [[{ repo: { id: "m1" } }, { repo: { id: "m2" } }]],
      async (calls) => {
        const { loadVirtualMembers } = await import("./virtual");
        const r = await loadVirtualMembers("virt_1");
        expect(calls.map((c) => c.op)).toContain("orderBy");
        return r;
      },
    );
    expect(repos).toEqual([{ id: "m1" }, { id: "m2" }]);
  });
});

describe("addVirtualMember", () => {
  afterEach(() => mock.restore());

  test("rejects a member from a different org", async () => {
    // parent org read, member org read (mismatch).
    await withFakeDb([[{ orgId: "org_parent" }], [{ orgId: "org_other" }]], async () => {
      const { addVirtualMember, VirtualMemberOrgMismatchError } = await import("./virtual");
      await expect(addVirtualMember("virt_1", "member_1")).rejects.toBeInstanceOf(
        VirtualMemberOrgMismatchError,
      );
    });
  });

  test("is a no-op when the membership already exists", async () => {
    // parent, member (same org), existing-membership row present.
    await withFakeDb(
      [[{ orgId: "org_1" }], [{ orgId: "org_1" }], [{ id: "vm_existing" }]],
      async (calls) => {
        const { addVirtualMember } = await import("./virtual");
        await addVirtualMember("virt_1", "member_1");
        // No insert should run when the binding already exists.
        expect(calls.map((c) => c.op)).not.toContain("insert");
      },
    );
  });

  test("throws when the member limit is exceeded", async () => {
    const real = await import("@hootifactory/config");
    const max = real.env.REGISTRY_MAX_VIRTUAL_MEMBERS;
    // parent, member (same org), no existing membership, count at the limit.
    await withFakeDb(
      [[{ orgId: "org_1" }], [{ orgId: "org_1" }], [], [{ count: max }]],
      async () => {
        const { addVirtualMember, VirtualMemberLimitExceededError } = await import("./virtual");
        await expect(addVirtualMember("virt_1", "member_1")).rejects.toBeInstanceOf(
          VirtualMemberLimitExceededError,
        );
      },
    );
  });

  test("inserts the membership when under the limit and not yet a member", async () => {
    // parent, member (same org), no existing membership, count below limit.
    await withFakeDb(
      [[{ orgId: "org_1" }], [{ orgId: "org_1" }], [], [{ count: 0 }]],
      async (calls) => {
        const { addVirtualMember } = await import("./virtual");
        await addVirtualMember("virt_1", "member_1", 2);
        const values = calls.find((c) => c.op === "values");
        expect(values?.args[0]).toEqual({
          virtualRepoId: "virt_1",
          memberRepoId: "member_1",
          position: 2,
        });
        expect(calls.map((c) => c.op)).toContain("onConflictDoNothing");
      },
    );
  });
});

describe("virtual member errors", () => {
  test("carry descriptive messages", async () => {
    const { VirtualMemberLimitExceededError, VirtualMemberOrgMismatchError } = await import(
      "./virtual"
    );
    expect(new VirtualMemberLimitExceededError(5).message).toContain("at most 5");
    expect(new VirtualMemberOrgMismatchError().message).toContain("same organization");
  });
});
