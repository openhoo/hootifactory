import { describe, expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { primaryId, timestamps } from "./_helpers";
import * as schema from "./index";

/**
 * Pure structural tests over the Drizzle schema. Importing the tables executes
 * every `pgTable(...)` / column-builder definition, and the introspection API
 * (`getTableName` / `getTableColumns`) lets us assert the physical table and
 * column contract without a live database. These guard the SQL-visible surface
 * that migrations, queries, and downstream packages all depend on.
 */

/**
 * The schema's logical column keys. Drizzle stores `.name` as the explicitly set
 * column name or the JS key (the snake_case mapping is applied by the db instance
 * via `casing: "snake_case"`, not baked into the builder), so we assert against
 * the model keys here.
 */
function columnKeys(table: PgTable): string[] {
  return Object.keys(getTableColumns(table));
}

function column(table: PgTable, key: string): PgColumn {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  const col = cols[key];
  if (!col) throw new Error(`no column ${key} on ${getTableName(table)}`);
  return col;
}

/** varchar(N) max length, exposed by drizzle's PgVarchar as `.length`. */
function varcharLength(table: PgTable, key: string): number | undefined {
  return (column(table, key) as unknown as { length?: number }).length;
}

/** Materialize a column builder into its built PgColumn (the `.build` method is
 * internal to drizzle's builder types, hence the cast). */
function buildColumn(builder: unknown): PgColumn {
  return (builder as { build(table: unknown): PgColumn }).build({});
}

describe("schema barrel", () => {
  test("re-exports every table from each schema module", () => {
    // Touch one representative export per module so the barrel's `export *`
    // lines are all exercised and the public surface stays wired up.
    expect(getTableName(schema.organizations)).toBe("organizations");
    expect(getTableName(schema.users)).toBe("users");
    expect(getTableName(schema.memberships)).toBe("memberships");
    expect(getTableName(schema.apiTokens)).toBe("api_tokens");
    expect(getTableName(schema.repositories)).toBe("repositories");
    expect(getTableName(schema.packages)).toBe("packages");
    expect(getTableName(schema.blobs)).toBe("blobs");
    expect(getTableName(schema.artifacts)).toBe("artifacts");
    expect(getTableName(schema.quotas)).toBe("quotas");
    expect(schema.repoKindEnum.enumValues.length).toBeGreaterThan(0);
  });
});

describe("_helpers column factories", () => {
  test("primaryId is a uuid primary key with a random default", () => {
    const built = buildColumn(primaryId());
    expect(built.primary).toBe(true);
    expect(built.dataType).toBe("string");
    expect(built.hasDefault).toBe(true);
  });

  test("timestamps returns fresh createdAt/updatedAt builders each call", () => {
    const a = timestamps();
    const b = timestamps();
    expect(Object.keys(a)).toEqual(["createdAt", "updatedAt"]);
    // A new builder instance per call (never a shared singleton).
    expect(a.createdAt).not.toBe(b.createdAt);
    const createdAt = buildColumn(a.createdAt);
    const updatedAt = buildColumn(a.updatedAt);
    expect(createdAt.notNull).toBe(true);
    expect(createdAt.hasDefault).toBe(true);
    expect(updatedAt.notNull).toBe(true);
    expect(updatedAt.hasDefault).toBe(true);
  });
});

describe("tenancy tables", () => {
  test("organizations keys on a uuid id with a unique slug", () => {
    expect(getTableName(schema.organizations)).toBe("organizations");
    expect(columnKeys(schema.organizations)).toEqual([
      "id",
      "slug",
      "displayName",
      "description",
      "createdAt",
      "updatedAt",
    ]);
    expect(column(schema.organizations, "slug").isUnique).toBe(true);
    expect(column(schema.organizations, "displayName").notNull).toBe(true);
  });

  test("users carry unique email + username and system/active flags", () => {
    const cols = columnKeys(schema.users);
    expect(cols).toContain("email");
    expect(cols).toContain("username");
    expect(cols).toContain("passwordHash");
    expect(column(schema.users, "email").isUnique).toBe(true);
    expect(column(schema.users, "username").isUnique).toBe(true);
    expect(column(schema.users, "isSystem").notNull).toBe(true);
    expect(column(schema.users, "isSystem").default).toBe(false);
    expect(column(schema.users, "isActive").default).toBe(true);
  });

  test("memberships link users to organizations without legacy roles", () => {
    expect(getTableName(schema.memberships)).toBe("memberships");
    expect(columnKeys(schema.memberships)).not.toContain("role");
    expect(column(schema.memberships, "orgId").notNull).toBe(true);
  });

  test("groups and group memberships model local access groups", () => {
    expect(getTableName(schema.groups)).toBe("groups");
    expect(column(schema.groups, "orgId").notNull).toBe(true);
    expect(column(schema.groups, "slug").notNull).toBe(true);
    expect(column(schema.groups, "displayName").notNull).toBe(true);
    expect(getTableName(schema.groupMemberships)).toBe("group_memberships");
    expect(column(schema.groupMemberships, "groupId").notNull).toBe(true);
    expect(column(schema.groupMemberships, "userId").notNull).toBe(true);
    expect(column(schema.groupMemberships, "source").default).toBe("local");
  });
});

describe("auth tables", () => {
  test("api_tokens default to personal type without embedded grants", () => {
    expect(getTableName(schema.apiTokens)).toBe("api_tokens");
    expect(column(schema.apiTokens, "type").default).toBe("personal");
    expect(columnKeys(schema.apiTokens)).not.toContain("grants");
    expect(columnKeys(schema.apiTokens)).not.toContain("role");
    expect(column(schema.apiTokens, "tokenHash").isUnique).toBe(true);
    expect(varcharLength(schema.apiTokens, "tokenHash")).toBe(64);
    expect(varcharLength(schema.apiTokens, "tokenPrefix")).toBe(16);
  });

  test("permission_grants model fine-grained subjects and scopes", () => {
    expect(getTableName(schema.permissionGrants)).toBe("permission_grants");
    expect(column(schema.permissionGrants, "permission").notNull).toBe(true);
    expect(column(schema.permissionGrants, "orgId").notNull).toBe(false);
    expect(column(schema.permissionGrants, "userId").notNull).toBe(false);
    expect(column(schema.permissionGrants, "groupId").notNull).toBe(false);
    expect(column(schema.permissionGrants, "tokenId").notNull).toBe(false);
    expect(column(schema.permissionGrants, "repositoryPattern").notNull).toBe(false);
  });

  test("sessions hash is unique and expiry is required", () => {
    expect(getTableName(schema.sessions)).toBe("sessions");
    expect(column(schema.sessions, "tokenHash").isUnique).toBe(true);
    expect(column(schema.sessions, "expiresAt").notNull).toBe(true);
  });

  test("auth_email_tokens default to empty metadata", () => {
    expect(getTableName(schema.authEmailTokens)).toBe("auth_email_tokens");
    expect(column(schema.authEmailTokens, "metadata").default).toEqual({});
    expect(varcharLength(schema.authEmailTokens, "email")).toBe(320);
  });

  test("auth_throttle_buckets key on the bucket hash", () => {
    expect(getTableName(schema.authThrottleBuckets)).toBe("auth_throttle_buckets");
    expect(column(schema.authThrottleBuckets, "bucketHash").primary).toBe(true);
    expect(column(schema.authThrottleBuckets, "count").default).toBe(0);
  });

  test("email_deliveries track delivery keys with a nullable confirmation stamp", () => {
    expect(getTableName(schema.emailDeliveries)).toBe("email_deliveries");
    expect(varcharLength(schema.emailDeliveries, "deliveryKey")).toBe(256);
    // sentAt is a post-send confirmation: claims start unconfirmed (NULL), so
    // it must be nullable with no insert-time default.
    expect(column(schema.emailDeliveries, "sentAt").notNull).toBe(false);
    expect(column(schema.emailDeliveries, "sentAt").hasDefault).toBe(false);
  });

  test("external identities are wired", () => {
    expect(getTableName(schema.externalIdentities)).toBe("external_identities");
    expect(column(schema.externalIdentities, "provider").notNull).toBe(true);
    expect(column(schema.externalIdentities, "issuer").notNull).toBe(true);
  });
});

describe("repository tables", () => {
  test("repositories default to hosted/private with required mount path", () => {
    expect(getTableName(schema.repositories)).toBe("repositories");
    expect(column(schema.repositories, "kind").default).toBe("hosted");
    expect(column(schema.repositories, "visibility").default).toBe("private");
    expect(column(schema.repositories, "moduleId").name).toBe("module_id");
    expect(column(schema.repositories, "mountPath").notNull).toBe(true);
    expect(column(schema.repositories, "config").default).toEqual({});
  });

  test("repository_upstreams default priority + ttl", () => {
    expect(getTableName(schema.repositoryUpstreams)).toBe("repository_upstreams");
    expect(column(schema.repositoryUpstreams, "priority").default).toBe(0);
    expect(column(schema.repositoryUpstreams, "cacheTtlSeconds").default).toBe(3600);
  });

  test("virtual_repo_members default to position 0", () => {
    expect(getTableName(schema.virtualRepoMembers)).toBe("virtual_repo_members");
    expect(column(schema.virtualRepoMembers, "position").default).toBe(0);
  });
});

describe("package tables", () => {
  test("packages default to empty metadata", () => {
    expect(getTableName(schema.packages)).toBe("packages");
    expect(column(schema.packages, "metadata").default).toEqual({});
    expect(column(schema.packages, "name").notNull).toBe(true);
  });

  test("package_versions default size + nullable deletion", () => {
    expect(getTableName(schema.packageVersions)).toBe("package_versions");
    expect(column(schema.packageVersions, "sizeBytes").default).toBe(0);
    expect(column(schema.packageVersions, "deletedAt").notNull).toBe(false);
  });

  test("version_tags require a tag and version", () => {
    expect(getTableName(schema.versionTags)).toBe("version_tags");
    expect(column(schema.versionTags, "tag").notNull).toBe(true);
    expect(column(schema.versionTags, "versionId").notNull).toBe(true);
  });
});

describe("governance tables", () => {
  test("quotas track used storage/artifact counts", () => {
    expect(getTableName(schema.quotas)).toBe("quotas");
    expect(column(schema.quotas, "usedStorageBytes").default).toBe(0);
    expect(column(schema.quotas, "usedArtifacts").default).toBe(0);
  });

  test("retention_policies default to delete with empty rules", () => {
    expect(getTableName(schema.retentionPolicies)).toBe("retention_policies");
    expect(column(schema.retentionPolicies, "action").default).toBe("delete");
    expect(column(schema.retentionPolicies, "rules").default).toEqual({});
  });

  test("audit_log is append-only with required result", () => {
    expect(getTableName(schema.auditLog)).toBe("audit_log");
    expect(column(schema.auditLog, "action").notNull).toBe(true);
    expect(column(schema.auditLog, "result").notNull).toBe(true);
    // No updatedAt on an append-only ledger.
    expect(columnKeys(schema.auditLog)).not.toContain("updatedAt");
  });
});

describe("scanning tables", () => {
  test("artifacts default to pending state", () => {
    expect(getTableName(schema.artifacts)).toBe("artifacts");
    expect(column(schema.artifacts, "state").default).toBe("pending");
    expect(varcharLength(schema.artifacts, "digest")).toBe(80);
  });

  test("scan_outbox defaults for the durable worker", () => {
    expect(getTableName(schema.scanOutbox)).toBe("scan_outbox");
    expect(column(schema.scanOutbox, "status").default).toBe("pending");
    expect(column(schema.scanOutbox, "attempts").default).toBe(0);
  });

  test("scans default version columns to empty strings", () => {
    expect(getTableName(schema.scans)).toBe("scans");
    expect(column(schema.scans, "scannerVersion").default).toBe("");
    expect(column(schema.scans, "dbVersion").default).toBe("");
    expect(column(schema.scans, "status").default).toBe("pending");
  });

  test("findings default severity to unknown", () => {
    expect(getTableName(schema.findings)).toBe("findings");
    expect(column(schema.findings, "severity").default).toBe("unknown");
    expect(column(schema.findings, "type").notNull).toBe(true);
  });

  test("scan_policies default to audit mode for all repos", () => {
    expect(getTableName(schema.scanPolicies)).toBe("scan_policies");
    expect(column(schema.scanPolicies, "mode").default).toBe("audit");
    expect(column(schema.scanPolicies, "repositoryPattern").default).toBe("*");
    expect(column(schema.scanPolicies, "blockOnMalware").default).toBe("true");
  });
});

describe("storage tables", () => {
  test("blobs key on digest and default to active with refCount 0", () => {
    expect(getTableName(schema.blobs)).toBe("blobs");
    expect(column(schema.blobs, "digest").primary).toBe(true);
    expect(column(schema.blobs, "refCount").default).toBe(0);
    expect(column(schema.blobs, "state").default).toBe("active");
  });

  test("blob_refs default to an empty scope", () => {
    expect(getTableName(schema.blobRefs)).toBe("blob_refs");
    expect(column(schema.blobRefs, "scope").default).toBe("");
    expect(column(schema.blobRefs, "kind").notNull).toBe(true);
  });

  test("content_manifests keep exact raw bytes", () => {
    expect(getTableName(schema.contentManifests)).toBe("content_manifests");
    expect(column(schema.contentManifests, "raw").notNull).toBe(true);
    expect(column(schema.contentManifests, "mediaType").notNull).toBe(true);
  });

  test("registry_assets default size/metadata/scope", () => {
    expect(getTableName(schema.registryAssets)).toBe("registry_assets");
    expect(column(schema.registryAssets, "sizeBytes").default).toBe(0);
    expect(column(schema.registryAssets, "metadata").default).toEqual({});
    expect(column(schema.registryAssets, "scope").default).toBe("");
  });

  test("content_tags + content_blob_refs are wired", () => {
    expect(getTableName(schema.contentTags)).toBe("content_tags");
    expect(getTableName(schema.contentBlobRefs)).toBe("content_blob_refs");
    expect(column(schema.contentTags, "tag").notNull).toBe(true);
  });

  test("upload_sessions default to open with zero offset", () => {
    expect(getTableName(schema.uploadSessions)).toBe("upload_sessions");
    expect(column(schema.uploadSessions, "state").default).toBe("open");
    expect(column(schema.uploadSessions, "offsetBytes").default).toBe(0);
    expect(column(schema.uploadSessions, "scope").default).toBe("");
  });
});
