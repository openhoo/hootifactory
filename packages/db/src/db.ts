import { drizzle } from "drizzle-orm/bun-sql";
import { createDatabaseClient } from "./client";
import * as schema from "./schema";

/** Drizzle database handle, snake_case column mapping, full schema bound for the relational API. */
export const db = drizzle({
  client: createDatabaseClient(),
  schema,
  casing: "snake_case",
});

export type Database = typeof db;
export type Schema = typeof schema;
