/**
 * In-memory, hermetic stand-in for the Drizzle `db` handle used by the auth
 * package's persistence helpers. Tests install it over the real `db` object's
 * query methods (insert/select/update/delete/transaction) so that the pure
 * orchestration logic around each query can be exercised without a database.
 *
 * The fake records every leaf query the code under test issues and replies with
 * results the test pre-loaded (FIFO). Each query builder is a Proxy that is both
 * chainable (any unknown method returns the same builder) and awaitable (it
 * resolves to the next queued result, defaulting to an empty array).
 *
 * This is test-only infrastructure; it is not exported from the package index.
 */

export type FakeQueryKind = "insert" | "select" | "update" | "delete";

export interface RecordedQuery {
  kind: FakeQueryKind;
  /** Values passed to `.values(...)` for inserts/updates, if any. */
  values?: unknown;
  /** Object passed to `.set(...)` for updates, if any. */
  set?: unknown;
  /** Whether `.onConflictDoUpdate(...)` was chained. */
  onConflict?: boolean;
}

type MutableDbLike = {
  insert: (...args: unknown[]) => unknown;
  select: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  delete: (...args: unknown[]) => unknown;
  transaction: (...args: unknown[]) => unknown;
};

/**
 * The real Drizzle `db` handle has heavily overloaded query-method signatures
 * that do not structurally satisfy `MutableDbLike`, so callers pass it as
 * `unknown` and the harness narrows it internally. Any object exposing the five
 * query methods is accepted.
 */
type DbLike = unknown;

export class FakeDb {
  /** Queued results returned, in order, to each awaited leaf query. */
  private results: unknown[] = [];
  /** Every query the code under test issued, in order. */
  readonly queries: RecordedQuery[] = [];

  /** Pre-load the result for the next awaited query (FIFO). */
  queue(result: unknown): this {
    this.results.push(result);
    return this;
  }

  private nextResult(): unknown {
    return this.results.length > 0 ? this.results.shift() : [];
  }

  private builder(record: RecordedQuery): unknown {
    const self = this;
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === "then") {
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(self.nextResult()).then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          if (prop === "values") record.values = args[0];
          if (prop === "set") record.set = args[0];
          if (prop === "onConflictDoUpdate") record.onConflict = true;
          return proxy;
        };
      },
    };
    const proxy: unknown = new Proxy({}, handler);
    return proxy;
  }

  private begin(kind: FakeQueryKind): unknown {
    const record: RecordedQuery = { kind };
    this.queries.push(record);
    return this.builder(record);
  }

  /** A transaction simply runs the callback with the same fake handle as `tx`. */
  private readonly tx = {
    insert: () => this.begin("insert"),
    select: () => this.begin("select"),
    update: () => this.begin("update"),
    delete: () => this.begin("delete"),
  };

  /** Install over the real db object; returns a restore() to undo it. */
  install(dbHandle: DbLike): () => void {
    const db = dbHandle as MutableDbLike;
    const original = {
      insert: db.insert,
      select: db.select,
      update: db.update,
      delete: db.delete,
      transaction: db.transaction,
    };
    db.insert = () => this.begin("insert");
    db.select = () => this.begin("select");
    db.update = () => this.begin("update");
    db.delete = () => this.begin("delete");
    db.transaction = (...args: unknown[]) => {
      const cb = args[0] as (tx: unknown) => unknown;
      return Promise.resolve(cb(this.tx));
    };
    return () => {
      db.insert = original.insert;
      db.select = original.select;
      db.update = original.update;
      db.delete = original.delete;
      db.transaction = original.transaction;
    };
  }
}

/** Convenience: install a fresh FakeDb, run `fn`, then always restore. */
export async function withFakeDb<T>(db: DbLike, fn: (fake: FakeDb) => Promise<T> | T): Promise<T> {
  const fake = new FakeDb();
  const restore = fake.install(db);
  try {
    return await fn(fake);
  } finally {
    restore();
  }
}
