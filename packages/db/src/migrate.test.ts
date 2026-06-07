import { afterEach, describe, expect, mock, test } from "bun:test";
import { runMigrations } from "./migrate";

/**
 * `migrate.ts` exposes `runMigrations()` and only runs the script side effects
 * (`process.exit(0)`) under `import.meta.main`, so importing it here is inert.
 * We mock *only* drizzle's migrator — the one module imported solely by
 * migrate.ts, so the global `mock.module` can't leak into sibling test files
 * under Bun's single-process `--parallel` runner — and let the real lazy
 * `createDatabaseClient()` / `drizzle()` run without touching a database.
 */

describe("runMigrations", () => {
  afterEach(async () => {
    const migrator = await import("drizzle-orm/bun-sql/migrator");
    await mock.module("drizzle-orm/bun-sql/migrator", () => ({ ...migrator }));
    mock.restore();
  });

  test("applies drizzle migrations from the shipped migrations folder", async () => {
    let migrateCalls = 0;
    let folder: string | undefined;
    let dbArg: unknown;

    await mock.module("drizzle-orm/bun-sql/migrator", () => ({
      migrate: async (db: unknown, opts: { migrationsFolder: string }) => {
        migrateCalls += 1;
        dbArg = db;
        folder = opts.migrationsFolder;
      },
    }));

    await runMigrations();

    expect(migrateCalls).toBe(1);
    // A real drizzle handle is built and handed to the migrator (no DB hit).
    expect(dbArg).toBeDefined();
    // Migrations are resolved relative to the package, ending in `migrations`.
    expect(folder).toMatch(/migrations$/);
  });
});
