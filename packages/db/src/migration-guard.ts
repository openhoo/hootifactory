/**
 * Pre-flight guard for the 2026-06 migration squash: databases migrated before
 * the squash carry __drizzle_migrations rows from the old chain. Drizzle's
 * migrator compares only created_at timestamps, so it would re-apply the
 * squashed 0000 (non-idempotent CREATE TYPE/TABLE) on top of the live schema
 * and fail mid-DDL. Detect the legacy rows up front and abort with
 * instructions instead.
 */

/** Recorded migration timestamps that do not belong to the current journal. */
export function legacyMigrationTimestamps(
  recorded: readonly number[],
  journal: readonly number[],
): number[] {
  const known = new Set(journal);
  return recorded.filter((timestamp) => !known.has(timestamp));
}

export function legacyChainMessage(legacy: readonly number[]): string {
  const stamps = legacy.map((timestamp) => new Date(timestamp).toISOString()).join(", ");
  return [
    "[db] refusing to migrate: this database was migrated before the 2026-06 migration squash",
    `[db] (found ${legacy.length} recorded migration(s) not in the current journal: ${stamps}).`,
    "[db] Re-running the squashed 0000 against a live schema would fail mid-DDL.",
    "[db] Options:",
    "[db]   - dev databases: drop + recreate, then `bun run db:migrate`",
    "[db]   - keep the data: verify the schema is current, then `bun run db:baseline --yes`",
    "[db]     to mark the squashed chain as applied without running it (see README",
    '[db]     "Upgrading across the migration squash").',
  ].join("\n");
}
