import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDatabaseClient } from "./client";
import { legacyChainMessage, legacyMigrationTimestamps } from "./migration-guard";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

async function recordedMigrationTimestamps(client: SQL): Promise<number[]> {
  const [table] = await client`
    select 1 as present
    from information_schema.tables
    where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
  `;
  if (!table) return [];
  const rows = await client`
    select created_at from drizzle.__drizzle_migrations order by created_at asc
  `;
  return rows.map((row: { created_at: string | number }) => Number(row.created_at));
}

/** Abort before any DDL when the database carries a pre-squash migration chain. */
export async function assertNoLegacyMigrationChain(client: SQL): Promise<void> {
  const recorded = await recordedMigrationTimestamps(client);
  const journal = readMigrationFiles({ migrationsFolder }).map((m) => m.folderMillis);
  const legacy = legacyMigrationTimestamps(recorded, journal);
  if (legacy.length > 0) {
    throw new Error(legacyChainMessage(legacy));
  }
}

/**
 * Injectable collaborators so the unit test can exercise the flow without a
 * database or module mocks (which can leak across files under the parallel
 * runner); production callers pass nothing.
 */
export interface RunMigrationsDeps {
  createClient?: typeof createDatabaseClient;
  guard?: typeof assertNoLegacyMigrationChain;
  applyMigrations?: typeof migrate;
}

/** Apply all pending drizzle migrations against a freshly-built client. */
export async function runMigrations(deps: RunMigrationsDeps = {}): Promise<void> {
  const createClient = deps.createClient ?? createDatabaseClient;
  const guard = deps.guard ?? assertNoLegacyMigrationChain;
  const applyMigrations = deps.applyMigrations ?? migrate;
  const client = createClient();
  await guard(client);
  const db = drizzle({ client });
  console.log(`[db] applying migrations from ${migrationsFolder}`);
  await applyMigrations(db, { migrationsFolder });
  console.log("[db] migrations applied");
}

// Only run as a side effect when invoked as a script (`bun run .../migrate.ts`),
// not when imported (e.g. by tests). Keeps the CLI entrypoint behavior intact.
if (import.meta.main) {
  await runMigrations();
  process.exit(0);
}
