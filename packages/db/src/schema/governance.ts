import {
  bigint,
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
import { auditResultEnum } from "./enums";
import { organizations } from "./tenancy";

/** Storage/artifact quotas, per org (repository null) or per repository. */
export const quotas = pgTable(
  "quotas",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid(),
    maxStorageBytes: bigint({ mode: "number" }),
    usedStorageBytes: bigint({ mode: "number" }).notNull().default(0),
    maxArtifacts: bigint({ mode: "number" }),
    usedArtifacts: bigint({ mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex("quotas_org_repo_uq").on(t.orgId, t.repositoryId)],
);

export interface RetentionRule {
  keepLastN?: number;
  maxAgeDays?: number;
  tagPattern?: string;
}

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid(),
    rules: jsonb().$type<RetentionRule>().notNull().default({}),
    action: text().notNull().default("delete"),
    ...timestamps(),
  },
  (t) => [index("retention_policies_org_idx").on(t.orgId)],
);

/** Append-only audit trail. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: primaryId(),
    orgId: uuid().references(() => organizations.id, { onDelete: "set null" }),
    actorUserId: uuid(),
    actorTokenId: uuid(),
    actorLabel: text(),
    action: text().notNull(),
    resourceType: text(),
    resourceId: text(),
    result: auditResultEnum().notNull(),
    ip: varchar({ length: 64 }),
    detail: jsonb().$type<Record<string, unknown> | null>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_log_action_idx").on(t.action),
  ],
);
