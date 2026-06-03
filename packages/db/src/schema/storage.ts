import { sql } from "drizzle-orm";
import {
  bigint,
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
import { blobRefKindEnum, blobStateEnum, uploadStateEnum } from "./enums";
import { packages, packageVersions } from "./packages";
import { repositories } from "./repositories";
import { organizations } from "./tenancy";

/**
 * Global content-addressable blob registry. One row per unique sha256 across
 * the whole system (cross-tenant dedup). ref_count drives GC; possessing a
 * digest grants NO access — authorization happens at the blob_refs/repo layer.
 */
export const blobs = pgTable(
  "blobs",
  {
    /** "sha256:<hex>" */
    digest: varchar({ length: 80 }).primaryKey(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    storageKey: text().notNull(),
    mediaType: text(),
    refCount: integer().notNull().default(0),
    state: blobStateEnum().notNull().default("active"),
    pendingSince: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index("blobs_gc_idx").on(t.digest).where(sql`${t.refCount} = 0`)],
);

/**
 * A logical reference to a blob from a repo (a "mount" is one insert). The
 * (kind, repo, scope, digest) tuple is unique; ref_count on blobs is the count
 * of these rows, maintained transactionally.
 */
export const blobRefs = pgTable(
  "blob_refs",
  {
    id: primaryId(),
    digest: varchar({ length: 80 })
      .notNull()
      .references(() => blobs.digest, { onDelete: "restrict" }),
    kind: blobRefKindEnum().notNull(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Logical owner of the reference: "name@version", manifest digest, file path. */
    scope: text().notNull().default(""),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("blob_refs_uq").on(t.kind, t.repositoryId, t.scope, t.digest),
    index("blob_refs_digest_idx").on(t.digest),
    index("blob_refs_repo_idx").on(t.repositoryId),
  ],
);

/**
 * OCI manifests. `raw` holds the EXACT manifest bytes (never re-marshalled) so
 * Docker-Content-Digest stays byte-exact. Parsed fields are denormalized.
 */
export const ociManifests = pgTable(
  "oci_manifests",
  {
    id: primaryId(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    digest: varchar({ length: 80 }).notNull(),
    mediaType: text().notNull(),
    artifactType: text(),
    subjectDigest: varchar({ length: 80 }),
    /** Exact manifest bytes as stored/served. */
    raw: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    configDigest: varchar({ length: 80 }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("oci_manifests_repo_digest_uq").on(t.repositoryId, t.digest),
    index("oci_manifests_subject_idx").on(t.repositoryId, t.subjectDigest),
  ],
);

/**
 * Normalized registry asset catalog. This is the format-agnostic ownership row
 * for payloads exposed by packages/versions/manifests. Protocol metadata may
 * still snapshot digests, but asset rows are the durable data-management truth.
 */
export const registryAssets = pgTable(
  "registry_assets",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    packageId: uuid().references(() => packages.id, { onDelete: "cascade" }),
    packageVersionId: uuid().references(() => packageVersions.id, { onDelete: "cascade" }),
    ociManifestId: uuid().references(() => ociManifests.id, { onDelete: "cascade" }),
    blobRefId: uuid().references(() => blobRefs.id, { onDelete: "set null" }),
    digest: varchar({ length: 80 }).notNull(),
    /** Stable role from the registry data contract, e.g. npm_tarball or oci_layer. */
    role: text().notNull(),
    /** Logical protocol owner: name@version, filename, image path, manifest digest. */
    scope: text().notNull().default(""),
    path: text(),
    mediaType: text(),
    sizeBytes: bigint({ mode: "number" }).notNull().default(0),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("registry_assets_repo_role_scope_digest_uq").on(
      t.repositoryId,
      t.role,
      t.scope,
      t.digest,
    ),
    index("registry_assets_org_idx").on(t.orgId),
    index("registry_assets_repo_idx").on(t.repositoryId),
    index("registry_assets_package_idx").on(t.packageId),
    index("registry_assets_version_idx").on(t.packageVersionId),
    index("registry_assets_digest_idx").on(t.digest),
    index("registry_assets_manifest_idx").on(t.ociManifestId),
  ],
);

/** Mutable OCI tag -> manifest pointers. */
export const ociTags = pgTable(
  "oci_tags",
  {
    id: primaryId(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    packageId: uuid()
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    tag: text().notNull(),
    manifestId: uuid()
      .notNull()
      .references(() => ociManifests.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("oci_tags_pkg_tag_uq").on(t.packageId, t.tag),
    index("oci_tags_repo_idx").on(t.repositoryId),
    index("oci_tags_manifest_idx").on(t.manifestId),
  ],
);

/** Resumable upload sessions. The id IS the Docker-Upload-UUID. */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: primaryId(),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Image/repository path that owns this upload session. */
    scope: text().notNull().default(""),
    storageKey: text().notNull(),
    offsetBytes: bigint({ mode: "number" }).notNull().default(0),
    state: uploadStateEnum().notNull().default("open"),
    /** S3 multipart upload id + collected parts, when streaming large layers. */
    multipart: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index("upload_sessions_repo_idx").on(t.repositoryId)],
);
