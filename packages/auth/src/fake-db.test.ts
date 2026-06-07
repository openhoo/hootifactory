import { describe, expect, test } from "bun:test";
import { FakeDb, withFakeDb } from "./fake-db";

// A query builder is chainable (each method returns another builder) and
// awaitable; once the fake is installed these calls hit the harness instead.
// Only the methods the assertions below use are modelled.
interface ChainableBuilder extends PromiseLike<unknown> {
  values(value: unknown): ChainableBuilder;
  set(value: unknown): ChainableBuilder;
  where(value: unknown): ChainableBuilder;
  from(value: unknown): ChainableBuilder;
  limit(value: number): ChainableBuilder;
  onConflictDoUpdate(value: unknown): ChainableBuilder;
  returning(): ChainableBuilder;
}
type QueryFn = (...args: unknown[]) => ChainableBuilder;
interface FakeDbHandle {
  insert: QueryFn;
  select: QueryFn;
  update: QueryFn;
  delete: QueryFn;
  transaction: (cb: (tx: FakeDbHandle) => unknown) => Promise<unknown>;
}

// A minimal db-like object whose query methods are replaced by the fake.
function makeDb(): FakeDbHandle {
  const noop: QueryFn = () => {
    throw new Error("real db method should have been replaced");
  };
  return {
    insert: noop,
    select: noop,
    update: noop,
    delete: noop,
    transaction: noop as unknown as FakeDbHandle["transaction"],
  };
}

describe("FakeDb harness", () => {
  test("records query kind, values, set, and onConflict; returns queued results", async () => {
    const db = makeDb();
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "row-1" }]);
      const rows = await db
        .insert({})
        .values({ a: 1 })
        .onConflictDoUpdate({ set: { b: 2 } })
        .returning();
      expect(rows).toEqual([{ id: "row-1" }]);

      await db.update({}).set({ c: 3 }).where({});

      expect(fake.queries).toEqual([
        { kind: "insert", values: { a: 1 }, onConflict: true },
        { kind: "update", set: { c: 3 } },
      ]);
    });
  });

  test("defaults unqueued awaited queries to an empty array", async () => {
    const db = makeDb();
    await withFakeDb(db, async () => {
      const rows = await db.select().from({}).where({}).limit(1);
      expect(rows).toEqual([]);
    });
  });

  test("transactions run the callback with a tx that records onto the same fake", async () => {
    const db = makeDb();
    const fake = new FakeDb();
    const restore = fake.install(db);
    try {
      fake.queue([{ id: "tx-row" }]);
      const result = await db.transaction(async (tx) => {
        const rows = (await tx.insert({}).values({ x: 1 }).returning()) as { id: string }[];
        return rows[0];
      });
      expect(result).toEqual({ id: "tx-row" });
      expect(fake.queries[0]).toMatchObject({ kind: "insert", values: { x: 1 } });
    } finally {
      restore();
    }
    // After restore, the original (throwing) methods are back in place.
    expect(() => db.insert()).toThrow();
  });
});
