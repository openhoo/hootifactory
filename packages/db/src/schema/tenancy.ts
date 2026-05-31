import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";
import { roleNameEnum } from "./enums";

/** Tenant root. Everything tenant-scoped carries org_id. */
export const organizations = pgTable("organizations", {
  id: primaryId(),
  slug: varchar({ length: 128 }).notNull().unique(),
  displayName: text().notNull(),
  description: text(),
  ...timestamps(),
});

export const users = pgTable("users", {
  id: primaryId(),
  email: varchar({ length: 320 }).notNull().unique(),
  username: varchar({ length: 128 }).notNull().unique(),
  displayName: text(),
  /** Null for SSO-only or system identities. Hashed with Bun.password (argon2id). */
  passwordHash: text(),
  /** Robot / scan-worker identities that authenticate as a service. */
  isSystem: boolean().notNull().default(false),
  isActive: boolean().notNull().default(true),
  externalIdp: jsonb().$type<{ issuer: string; subject: string } | null>(),
  ...timestamps(),
});

/** A user's org-wide role. Repo-scoped overrides live in role_bindings. */
export const memberships = pgTable(
  "memberships",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleNameEnum().notNull().default("viewer"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);
