import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Standard UUID primary key. */
export const primaryId = () => uuid().primaryKey().defaultRandom();

/** created_at / updated_at columns. Returned as a factory to avoid sharing builder instances. */
export const timestamps = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
