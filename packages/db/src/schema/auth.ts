import type { PermissionKey, PolicyName, TokenTarget } from "@hootifactory/types";
import { sql } from "drizzle-orm";
import {
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
import { authEmailTokenPurposeEnum, tokenTypeEnum } from "./enums";
import { repositories } from "./repositories";
import { groups, organizations, users } from "./tenancy";

export type { TokenAction, TokenGrant } from "@hootifactory/types";

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

export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: primaryId(),
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid().references(() => groups.id, { onDelete: "cascade" }),
    tokenId: uuid().references(() => apiTokens.id, { onDelete: "cascade" }),
    permission: text().$type<PermissionKey>().notNull(),
    repositoryId: uuid().references(() => repositories.id, { onDelete: "cascade" }),
    repositoryPattern: text(),
    packagePattern: text(),
    artifactPattern: text(),
    policy: text().$type<PolicyName>(),
    tokenTarget: text().$type<TokenTarget>(),
    targetTokenId: uuid().references(() => apiTokens.id, { onDelete: "cascade" }),
    grantedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    source: varchar({ length: 32 }),
    ...timestamps(),
  },
  (t) => [
    index("permission_grants_org_idx").on(t.orgId),
    index("permission_grants_user_idx").on(t.userId),
    index("permission_grants_group_idx").on(t.groupId),
    index("permission_grants_token_idx").on(t.tokenId),
    index("permission_grants_repository_idx").on(t.repositoryId),
    uniqueIndex("permission_grants_user_scope_uq")
      .on(
        t.userId,
        t.orgId,
        t.permission,
        t.repositoryId,
        t.repositoryPattern,
        t.packagePattern,
        t.artifactPattern,
        t.policy,
        t.tokenTarget,
        t.targetTokenId,
      )
      .where(sql`${t.userId} is not null`),
    uniqueIndex("permission_grants_group_scope_uq")
      .on(
        t.groupId,
        t.orgId,
        t.permission,
        t.repositoryId,
        t.repositoryPattern,
        t.packagePattern,
        t.artifactPattern,
        t.policy,
        t.tokenTarget,
        t.targetTokenId,
      )
      .where(sql`${t.groupId} is not null`),
    uniqueIndex("permission_grants_token_scope_uq")
      .on(
        t.tokenId,
        t.orgId,
        t.permission,
        t.repositoryId,
        t.repositoryPattern,
        t.packagePattern,
        t.artifactPattern,
        t.policy,
        t.tokenTarget,
        t.targetTokenId,
      )
      .where(sql`${t.tokenId} is not null`),
    check(
      "permission_grants_one_subject_ck",
      sql`num_nonnulls(${t.userId}, ${t.groupId}, ${t.tokenId}) = 1`,
    ),
    check(
      "permission_grants_scoped_ck",
      sql`(
        (${t.permission} = 'system.admin' and ${t.orgId} is null and ${t.userId} is not null and ${t.groupId} is null and ${t.tokenId} is null and ${t.repositoryId} is null and ${t.repositoryPattern} is null and ${t.packagePattern} is null and ${t.artifactPattern} is null and ${t.policy} is null and ${t.tokenTarget} is null and ${t.targetTokenId} is null)
        or
        (${t.permission} <> 'system.admin' and ${t.orgId} is not null)
      )`,
    ),
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

/**
 * Durable idempotency ledger for at-least-once queued email delivery. A row is
 * a *claim* on a delivery key; `sentAt` is the post-SMTP confirmation and stays
 * NULL while the send is in flight. A claim whose `sentAt` is still NULL after
 * a takeover threshold (see the mail worker) is treated as abandoned by a
 * crashed worker and may be re-claimed, so an unconfirmed claim can never
 * permanently suppress a retry. `updatedAt` doubles as the claim stamp: it is
 * set on claim/takeover and gates whose rollback/confirmation may touch the row.
 */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: primaryId(),
    deliveryKey: varchar({ length: 256 }).notNull(),
    template: varchar({ length: 64 }).notNull(),
    recipient: varchar({ length: 320 }).notNull(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("email_deliveries_delivery_key_uq").on(t.deliveryKey)],
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
