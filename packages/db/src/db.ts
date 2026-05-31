import { env } from "@hootifactory/config";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/** Drizzle database handle, snake_case column mapping, full schema bound for the relational API. */
export const db = drizzle(env.DATABASE_URL, { schema, casing: "snake_case" });

export type Database = typeof db;
export type Schema = typeof schema;
