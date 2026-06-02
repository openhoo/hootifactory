import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";
import { packageFormatEnum, repoKindEnum, visibilityEnum } from "./enums";
import { organizations } from "./tenancy";

/**
 * A repository binds an org + package format + kind (hosted/proxy/virtual).
 * `mountPath` is the globally-unique URL prefix used to resolve incoming
 * registry requests to this repo (longest-prefix match in core).
 */
export const repositories = pgTable(
  "repositories",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: varchar({ length: 256 }).notNull(),
    format: packageFormatEnum().notNull(),
    kind: repoKindEnum().notNull().default("hosted"),
    visibility: visibilityEnum().notNull().default("private"),
    /** URL path prefix, e.g. "npm/acme-internal" or "acme/containers". Globally unique. */
    mountPath: varchar({ length: 512 }).notNull(),
    /** Storage key prefix namespace (defense-in-depth; CAS itself is global). */
    storagePrefix: varchar({ length: 256 }).notNull(),
    description: text(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("repositories_org_name_uq").on(t.orgId, t.name),
    uniqueIndex("repositories_mount_path_uq").on(t.mountPath),
    index("repositories_org_idx").on(t.orgId),
    index("repositories_format_idx").on(t.format),
  ],
);

/** Upstreams for proxy/remote repos (pull-through cache sources). */
export const repositoryUpstreams = pgTable(
  "repository_upstreams",
  {
    id: primaryId(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    url: text().notNull(),
    priority: integer().notNull().default(0),
    cacheTtlSeconds: integer().notNull().default(3600),
    credentials: jsonb().$type<Record<string, unknown> | null>(),
    ...timestamps(),
  },
  (t) => [index("repository_upstreams_repo_idx").on(t.repositoryId)],
);

/** Members of a virtual/group repo, in resolution order. */
export const virtualRepoMembers = pgTable(
  "virtual_repo_members",
  {
    id: primaryId(),
    virtualRepoId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    memberRepoId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("virtual_repo_members_uq").on(t.virtualRepoId, t.memberRepoId),
    index("virtual_repo_members_virtual_idx").on(t.virtualRepoId),
    index("virtual_repo_members_member_idx").on(t.memberRepoId),
  ],
);
