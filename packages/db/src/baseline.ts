import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDatabaseClient } from "./client";

/**
 * Operator tool for upgrading a database across the 2026-06 migration squash:
 * replaces the recorded (pre-squash) migration chain with the current journal,
 * marking every current migration as applied WITHOUT running its DDL.
 *
 * Only run this against a database whose schema you have verified to match the
 * squashed 0000 snapshot (i.e. it was fully migrated on the old chain). After
 * baselining, `bun run db:migrate` applies only genuinely new migrations.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

export async function baselineMigrations(): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
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
    for (const migration of migrations) {
      await tx`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${migration.hash}, ${migration.folderMillis})
      `;
    }
  });
  console.log(`[db] baselined ${migrations.length} migration(s) as applied (no DDL was executed)`);
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
