import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDatabaseClient } from "./client";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/** Apply all pending drizzle migrations against a freshly-built client. */
export async function runMigrations(): Promise<void> {
  const db = drizzle({ client: createDatabaseClient() });
  console.log(`[db] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log("[db] migrations applied");
}

// Only run as a side effect when invoked as a script (`bun run .../migrate.ts`),
// not when imported (e.g. by tests). Keeps the CLI entrypoint behavior intact.
if (import.meta.main) {
  await runMigrations();
  process.exit(0);
}
