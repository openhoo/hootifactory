import { execSync } from "node:child_process";

const DB_NAME = "hootifactory_test";
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? `postgres://hootifactory:hootifactory@localhost:5432/${DB_NAME}`;

/**
 * Ensure the isolated e2e database exists and is migrated, before the API
 * webServer starts serving tests. Runs under Node; shells out to Bun for the
 * migration so the Bun-only Drizzle driver is used.
 */
export default async function globalSetup(): Promise<void> {
  const pgEnv = { ...process.env, PGPASSWORD: "hootifactory" };
  try {
    execSync(`psql -h localhost -U hootifactory -d postgres -c "CREATE DATABASE ${DB_NAME}"`, {
      stdio: "ignore",
      env: pgEnv,
    });
    console.log(`[e2e] created database ${DB_NAME}`);
  } catch {
    // already exists — fine
  }

  execSync("bun run db:migrate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  console.log("[e2e] test database migrated");
}
