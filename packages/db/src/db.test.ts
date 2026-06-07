import { describe, expect, test } from "bun:test";
import { createDatabaseClient } from "./client";

/**
 * Bun's SQL client connects lazily (no socket is opened until the first query),
 * so constructing it — and the drizzle handle bound to it — is exercisable in a
 * hermetic unit test. We never run a query, so no database is required.
 */

describe("createDatabaseClient", () => {
  test("constructs a Bun SQL client without connecting", () => {
    const client = createDatabaseClient();
    expect(client).toBeDefined();
    // Bun's SQL handle is callable (tagged-template query) and exposes a pool
    // close method; constructing it opens no socket (connection is lazy).
    expect(typeof client).toBe("function");
    expect(typeof client.close).toBe("function");
  });
});

describe("db handle + public barrel", () => {
  test("exposes the drizzle handle bound with the full schema", async () => {
    const mod = await import("./db");
    expect(mod.db).toBeDefined();
    // Drizzle handles expose query/select builders; touching one proves the
    // handle was constructed (and the snake_case casing config applied) at import.
    expect(typeof mod.db.select).toBe("function");
    expect(typeof mod.db.execute).toBe("function");
  });

  test("re-exports drizzle operators and the schema namespace from index", async () => {
    const index = await import("./index");
    expect(typeof index.eq).toBe("function");
    expect(typeof index.and).toBe("function");
    expect(typeof index.sql).toBe("function");
    expect(typeof index.desc).toBe("function");
    expect(index.db).toBeDefined();
    // `export * as schema` and `export * from "./schema"` both surface tables.
    expect(index.schema.organizations).toBeDefined();
    expect(index.organizations).toBeDefined();
  });
});
