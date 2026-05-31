import { defineConfig } from "drizzle-kit";

const url =
  process.env.DATABASE_URL ?? "postgres://hootifactory:hootifactory@localhost:5432/hootifactory";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema/index.ts",
  out: "./packages/db/migrations",
  dbCredentials: { url },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
