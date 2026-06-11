import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { assertNoLegacyMigrationChain, runMigrations } from "./migrate";

/**
 * `migrate.ts` exposes `runMigrations()` and only runs the script side effects
 * (`process.exit(0)`) under `import.meta.main`, so importing it here is inert.
 * Collaborators are injected (no `mock.module`, which can leak into sibling
 * test files under Bun's parallel runner); the real lazy `drizzle()` handle is
 * built without touching a database.
 */

/** A fake Bun SQL tagged-template client returning canned rows per query. */
function fakeClient(rowsByQuery: (query: string) => unknown[]): SQL {
  const client = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    return Promise.resolve(rowsByQuery(query));
  };
  return client as unknown as SQL;
}

describe("runMigrations", () => {
  test("guards first, then applies migrations from the shipped folder", async () => {
    const calls: string[] = [];
    let folder: string | undefined;
    let dbArg: unknown;

    await runMigrations({
      createClient: () => {
        calls.push("client");
        return {} as SQL;
      },
      guard: async () => {
        calls.push("guard");
      },
      applyMigrations: async (db: unknown, opts: { migrationsFolder: string }) => {
        calls.push("migrate");
        dbArg = db;
        folder = opts.migrationsFolder;
      },
    });

    expect(calls).toEqual(["client", "guard", "migrate"]);
    // A real drizzle handle is built and handed to the migrator (no DB hit).
    expect(dbArg).toBeDefined();
    // Migrations are resolved relative to the package, ending in `migrations`.
    expect(folder).toMatch(/migrations$/);
  });

  test("a legacy (pre-squash) chain aborts before the migrator runs", async () => {
    let migrated = 0;
    const legacyClient = fakeClient((query) =>
      query.includes("information_schema") ? [{ present: 1 }] : [{ created_at: "1748000000000" }],
    );

    await expect(
      runMigrations({
        createClient: () => legacyClient,
        applyMigrations: async () => {
          migrated += 1;
        },
      }),
    ).rejects.toThrow(/refusing to migrate/);
    expect(migrated).toBe(0);
  });

  test("assertNoLegacyMigrationChain accepts a fresh database and the current chain", async () => {
    // Fresh database: no __drizzle_migrations table at all.
    await assertNoLegacyMigrationChain(fakeClient(() => []));
    // Already-migrated database: recorded rows all belong to the current journal.
    const { readMigrationFiles } = await import("drizzle-orm/migrator");
    const here = new URL("../migrations", import.meta.url).pathname;
    const current = readMigrationFiles({ migrationsFolder: here }).map((m) => ({
      created_at: String(m.folderMillis),
    }));
    await assertNoLegacyMigrationChain(
      fakeClient((query) => (query.includes("information_schema") ? [{ present: 1 }] : current)),
    );
  });
});
