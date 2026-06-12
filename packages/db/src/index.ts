// `@hootifactory/db` is the schema + configured client + operator re-exports —
// deliberately NOT a query/repository layer. The convention is that each domain
// package owns the queries for the tables it owns, co-located with the domain
// logic and invariants that use them: `@hootifactory/auth` owns users / tokens /
// permission grants / groups; `@hootifactory/registry-platform` owns repositories
// / packages / blobs / quota / retention; each worker owns its own outbox. New
// query logic belongs in the owning domain package (or a new one), not here —
// keeping persistence beside the rules it enforces rather than in a central
// data-access silo. Schema lives under `./schema`, organized by domain.

// Convenience re-exports of common Drizzle operators/helpers.
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
export * from "./db";
export * from "./schema";
export * as schema from "./schema";
