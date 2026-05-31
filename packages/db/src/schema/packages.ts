import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";
import { apiTokens } from "./auth";
import { repositories } from "./repositories";
import { organizations, users } from "./tenancy";

/** Format-agnostic package (npm name, pypi project, docker image, ...). */
export const packages = pgTable(
  "packages",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Normalized package name (e.g. PEP 503 normalized, npm full name incl. scope). */
    name: text().notNull(),
    namespace: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    latestVersion: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("packages_repo_name_uq").on(t.repositoryId, t.name),
    index("packages_org_idx").on(t.orgId),
    index("packages_name_idx").on(t.name),
  ],
);

export const packageVersions = pgTable(
  "package_versions",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    packageId: uuid()
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    sizeBytes: bigint({ mode: "number" }).notNull().default(0),
    publishedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    publishedByTokenId: uuid().references(() => apiTokens.id, { onDelete: "set null" }),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("package_versions_pkg_version_uq").on(t.packageId, t.version),
    index("package_versions_live_idx").on(t.packageId).where(sql`${t.deletedAt} is null`),
  ],
);

/** Mutable named pointers to versions: npm dist-tags, release channels, etc. */
export const versionTags = pgTable(
  "version_tags",
  {
    id: primaryId(),
    packageId: uuid()
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    tag: text().notNull(),
    versionId: uuid()
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("version_tags_pkg_tag_uq").on(t.packageId, t.tag)],
);
