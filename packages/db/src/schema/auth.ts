import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";
import { authEmailTokenPurposeEnum, roleNameEnum, tokenTypeEnum } from "./enums";
import { repositories } from "./repositories";
import { organizations, users } from "./tenancy";

export type TokenAction = "read" | "write" | "delete" | "admin";

/** Legacy request shape accepted only by pre-v1 token routes. */
export interface TokenScope {
  repository: string;
  actions: TokenAction[];
}

export type TokenGrant =
  | {
      resource: "org";
      actions: TokenAction[];
    }
  | {
      resource: "repository";
      repository: string;
      actions: TokenAction[];
    }
  | {
      resource: "package";
      repository: string;
      package: string;
      actions: TokenAction[];
    }
  | {
      resource: "artifact";
      repository: string;
      artifact: string;
      actions: TokenAction[];
    }
  | {
      resource: "policy";
      policy: "scan" | "quota" | "retention" | "*";
      repository?: string;
      actions: TokenAction[];
    }
  | {
      resource: "token";
      target: "self" | "org";
      actions: TokenAction[];
    };

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
    /** Grants beyond the owner's role; null/empty => inherit owner role for legacy tokens. */
    grants: jsonb().$type<TokenGrant[]>().notNull().default([]),
    /** Robot tokens may carry an explicit role at org scope. */
    role: roleNameEnum(),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    revokedByUserId: uuid(),
    revokedByTokenId: uuid(),
    revocationReason: text(),
    rotatedAt: timestamp({ withTimezone: true }),
    rotatedByUserId: uuid(),
    rotatedByTokenId: uuid(),
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

export interface AuthEmailTokenMetadata {
  [key: string]: unknown;
}

/** One-time, email-delivered auth tokens. Only SHA-256 hashes are stored. */
export const authEmailTokens = pgTable(
  "auth_email_tokens",
  {
    id: primaryId(),
    purpose: authEmailTokenPurposeEnum().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: varchar({ length: 320 }).notNull(),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    metadata: jsonb().$type<AuthEmailTokenMetadata>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    index("auth_email_tokens_user_purpose_idx").on(t.userId, t.purpose),
    index("auth_email_tokens_expires_idx").on(t.expiresAt),
  ],
);

export const authThrottleBuckets = pgTable(
  "auth_throttle_buckets",
  {
    bucketHash: varchar({ length: 64 }).primaryKey(),
    scope: varchar({ length: 64 }).notNull(),
    count: integer().notNull().default(0),
    resetAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("auth_throttle_buckets_reset_at_idx").on(t.resetAt)],
);

/** Durable idempotency ledger for at-least-once queued email delivery. */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: primaryId(),
    deliveryKey: varchar({ length: 256 }).notNull(),
    template: varchar({ length: 64 }).notNull(),
    recipient: varchar({ length: 320 }).notNull(),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("email_deliveries_delivery_key_uq").on(t.deliveryKey)],
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
    index("role_bindings_token_idx").on(t.tokenId),
    index("role_bindings_repository_idx").on(t.repositoryId),
    check("role_bindings_one_subject_ck", sql`(${t.userId} is null) <> (${t.tokenId} is null)`),
    uniqueIndex("role_bindings_user_repo_uq")
      .on(t.orgId, t.userId, t.repositoryId)
      .where(sql`${t.userId} is not null`),
    // A partial unique index dedupes org-wide user bindings (repositoryId IS NULL),
    // which the composite index above leaves distinct because NULLs are distinct.
    uniqueIndex("role_bindings_user_org_uq")
      .on(t.orgId, t.userId)
      .where(sql`${t.userId} is not null and ${t.repositoryId} is null`),
    uniqueIndex("role_bindings_token_repo_uq")
      .on(t.orgId, t.tokenId, t.repositoryId)
      .where(sql`${t.tokenId} is not null`),
    uniqueIndex("role_bindings_token_org_uq")
      .on(t.orgId, t.tokenId)
      .where(sql`${t.tokenId} is not null and ${t.repositoryId} is null`),
  ],
);

/** OIDC providers (Phase 4). Global when orgId is null. */
export const oidcProviders = pgTable(
  "oidc_providers",
  {
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
  },
  (t) => [index("oidc_providers_org_idx").on(t.orgId)],
);

/** External identity links for SSO providers. */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: primaryId(),
    provider: varchar({ length: 32 }).notNull(),
    issuer: text().notNull(),
    subject: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: varchar({ length: 320 }),
    lastLoginAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("external_identities_provider_subject_uq").on(t.provider, t.issuer, t.subject),
    index("external_identities_user_idx").on(t.userId),
  ],
);

/** Org-wide roles managed by an external auth provider and refreshed at login. */
export const externalRoleGrants = pgTable(
  "external_role_grants",
  {
    id: primaryId(),
    provider: varchar({ length: 32 }).notNull(),
    issuer: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: roleNameEnum().notNull(),
    groups: jsonb().$type<string[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("external_role_grants_provider_user_org_uq").on(
      t.provider,
      t.issuer,
      t.userId,
      t.orgId,
    ),
    index("external_role_grants_user_idx").on(t.userId),
    index("external_role_grants_org_idx").on(t.orgId),
  ],
);
