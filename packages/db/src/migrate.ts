import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDatabaseClient } from "./client";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const db = drizzle({ client: createDatabaseClient() });

console.log(`[db] applying migrations from ${migrationsFolder}`);
await migrate(db, { migrationsFolder });
console.log("[db] migrations applied");

process.exit(0);
