import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDatabaseClient } from "./client";

/**
 * Operator tool for upgrading a database across a migration squash:
 * replaces the recorded (pre-squash) migration chain with the current journal
 * up to the squash boundary (the last migration marked as a breakpoint),
 * marking those migrations as applied WITHOUT running their DDL.
 *
 * Post-squash migrations are left unstamped so `bun run db:migrate` will
 * apply them on the next run.
 *
 * Only run this against a database whose schema you have verified to match the
 * squashed snapshot (i.e. it was fully migrated on the old chain).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

export async function baselineMigrations(): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const lastBreakpoint = migrations.reduce<number>((last, m, i) => (m.bps ? i : last), -1);
  const toBaseline = lastBreakpoint >= 0 ? migrations.slice(0, lastBreakpoint + 1) : migrations;
  const skipped = migrations.length - toBaseline.length;

  const client = createDatabaseClient();
  await client`create schema if not exists drizzle`;
  await client`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;
  await client.begin(async (tx) => {
    await tx`delete from drizzle.__drizzle_migrations`;
    for (const migration of toBaseline) {
      await tx`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${migration.hash}, ${migration.folderMillis})
      `;
    }
  });
  const suffix =
    skipped > 0
      ? ` (skipped ${skipped} post-squash migration(s) — run db:migrate to apply them)`
      : "";
  console.log(
    `[db] baselined ${toBaseline.length} migration(s) as applied (no DDL was executed)${suffix}`,
  );
}

if (import.meta.main) {
  if (!process.argv.includes("--yes")) {
    console.error(
      "[db] db:baseline rewrites the recorded migration history WITHOUT running any DDL.\n" +
        "[db] Only do this on a database whose schema is already current (fully migrated\n" +
        "[db] on the pre-squash chain). Re-run with --yes to confirm.",
    );
    process.exit(1);
  }
  await baselineMigrations();
  process.exit(0);
}
