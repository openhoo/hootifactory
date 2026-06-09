import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";

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

/** A user's organization membership. Fine-grained permissions live in permission_grants. */
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
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const groups = pgTable(
  "groups",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: varchar({ length: 128 }).notNull(),
    displayName: text().notNull(),
    description: text(),
    /** Groups owned by an external provider are membership-synced at login. */
    managedBy: varchar({ length: 32 }),
    externalKey: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("groups_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("groups_org_slug_uq").on(t.orgId, t.slug),
    index("groups_org_idx").on(t.orgId),
    uniqueIndex("groups_external_uq")
      .on(t.orgId, t.managedBy, t.externalKey)
      .where(sql`${t.managedBy} is not null and ${t.externalKey} is not null`),
  ],
);

export const groupMemberships = pgTable(
  "group_memberships",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    groupId: uuid()
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: varchar({ length: 32 }).notNull().default("local"),
    provider: varchar({ length: 32 }),
    externalKey: text(),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: "group_memberships_org_group_fk",
      columns: [t.orgId, t.groupId],
      foreignColumns: [groups.orgId, groups.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "group_memberships_org_user_fk",
      columns: [t.orgId, t.userId],
      foreignColumns: [memberships.orgId, memberships.userId],
    }).onDelete("cascade"),
    uniqueIndex("group_memberships_group_user_uq").on(t.groupId, t.userId),
    index("group_memberships_org_user_idx").on(t.orgId, t.userId),
    index("group_memberships_group_idx").on(t.groupId),
  ],
);
