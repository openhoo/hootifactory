import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";
import { roleNameEnum, tokenTypeEnum } from "./enums";
import { repositories } from "./repositories";
import { organizations, users } from "./tenancy";

/** A scope entry on a token, e.g. { repository: "acme/*", actions: ["read","write"] }. */
export interface TokenScope {
  repository: string;
  actions: ("read" | "write" | "delete" | "admin")[];
}

/**
 * Opaque API tokens for CLI/registry clients. The secret is shown once at
 * creation; only its SHA-256 hash is stored. `tokenPrefix` is indexed for fast
 * candidate lookup before constant-time hash comparison.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    type: tokenTypeEnum().notNull().default("personal"),
    name: text().notNull(),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    tokenPrefix: varchar({ length: 16 }).notNull(),
    /** Scopes beyond the owner's role; null/empty => inherit owner role. */
    scopes: jsonb().$type<TokenScope[]>().notNull().default([]),
    /** Robot tokens may carry an explicit role at org scope. */
    role: roleNameEnum(),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("api_tokens_prefix_idx").on(t.tokenPrefix),
    index("api_tokens_org_idx").on(t.orgId),
    index("api_tokens_owner_idx").on(t.ownerUserId),
  ],
);

/** Server-side UI sessions (revocable). */
export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    ip: varchar({ length: 64 }),
    userAgent: text(),
    ...timestamps(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Repo-scoped (or org-wide when repositoryId is null) role assignments that
 * override org membership. Most-specific binding wins (resolved in code).
 */
export const roleBindings = pgTable(
  "role_bindings",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    tokenId: uuid().references(() => apiTokens.id, { onDelete: "cascade" }),
    repositoryId: uuid().references(() => repositories.id, { onDelete: "cascade" }),
    role: roleNameEnum().notNull(),
    ...timestamps(),
  },
  (t) => [
    index("role_bindings_org_idx").on(t.orgId),
    index("role_bindings_user_idx").on(t.userId),
    uniqueIndex("role_bindings_user_repo_uq")
      .on(t.orgId, t.userId, t.repositoryId)
      .where(sql`${t.userId} is not null`),
  ],
);

/** OIDC providers (Phase 4). Global when orgId is null. */
export const oidcProviders = pgTable("oidc_providers", {
  id: primaryId(),
  orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
  name: text().notNull(),
  issuer: text().notNull(),
  clientId: text().notNull(),
  clientSecret: text().notNull(),
  groupClaim: text().notNull().default("groups"),
  groupRoleMap: jsonb().$type<Record<string, string>>().notNull().default({}),
  enabled: boolean().notNull().default(true),
  ...timestamps(),
});
