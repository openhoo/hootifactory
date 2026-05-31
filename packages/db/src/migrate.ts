import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@hootifactory/config";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

const db = drizzle(env.DATABASE_URL);

console.log(`[db] applying migrations from ${migrationsFolder}`);
await migrate(db, { migrationsFolder });
console.log("[db] migrations applied");

process.exit(0);
