import {
  doublePrecision,
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
import {
  artifactStateEnum,
  findingTypeEnum,
  policyModeEnum,
  scanStatusEnum,
  scanTypeEnum,
  severityEnum,
} from "./enums";
import { repositories } from "./repositories";
import { organizations } from "./tenancy";

/** A scannable artifact (an OCI image/blob, npm tarball, pypi file) keyed by digest. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid()
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    digest: varchar({ length: 80 }).notNull(),
    mediaType: text(),
    name: text(),
    version: text(),
    state: artifactStateEnum().notNull().default("pending"),
    policyDecision: jsonb().$type<Record<string, unknown> | null>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("artifacts_org_repo_digest_uq").on(t.orgId, t.repositoryId, t.digest),
    index("artifacts_digest_idx").on(t.digest),
    index("artifacts_repo_idx").on(t.repositoryId),
    index("artifacts_state_idx").on(t.state),
  ],
);

/**
 * A single scan run by one scanner at a specific scanner+DB version. Deduped per
 * artifact so findings, retries, and artifact deletion stay scoped to the
 * artifact that owns them. raw output offloaded to object storage when large.
 */
export const scans = pgTable(
  "scans",
  {
    id: primaryId(),
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    blobDigest: varchar({ length: 80 }).notNull(),
    scanType: scanTypeEnum().notNull(),
    scanner: text().notNull(),
    scannerVersion: text().notNull().default(""),
    dbVersion: text().notNull().default(""),
    status: scanStatusEnum().notNull().default("pending"),
    sbomJson: jsonb().$type<Record<string, unknown> | null>(),
    sbomNativeJson: jsonb().$type<Record<string, unknown> | null>(),
    rawResultRef: text(),
    error: text(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("scans_dedup_uq").on(
      t.artifactId,
      t.blobDigest,
      t.scanType,
      t.scanner,
      t.scannerVersion,
      t.dbVersion,
    ),
    index("scans_artifact_idx").on(t.artifactId),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: primaryId(),
    scanId: uuid()
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    artifactId: uuid()
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    type: findingTypeEnum().notNull(),
    vulnId: text(),
    aliases: text().array(),
    purl: text(),
    packageName: text(),
    packageVersion: text(),
    severity: severityEnum().notNull().default("unknown"),
    cvssScore: doublePrecision(),
    fixedVersion: text(),
    title: text(),
    description: text(),
    data: jsonb().$type<Record<string, unknown> | null>(),
    ...timestamps(),
  },
  (t) => [
    index("findings_scan_idx").on(t.scanId),
    index("findings_artifact_idx").on(t.artifactId),
    index("findings_severity_idx").on(t.severity),
    index("findings_vuln_idx").on(t.vulnId),
  ],
);

export const sbomComponents = pgTable(
  "sbom_components",
  {
    id: primaryId(),
    scanId: uuid()
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    purl: text(),
    name: text().notNull(),
    version: text(),
    type: text(),
    licenses: jsonb().$type<string[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [index("sbom_components_scan_idx").on(t.scanId)],
);

/** Triage annotations on findings (VEX). */
export const vexAnnotations = pgTable(
  "vex_annotations",
  {
    id: primaryId(),
    findingId: uuid()
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    analysisState: text().notNull(),
    justification: text(),
    detail: text(),
    ...timestamps(),
  },
  (t) => [index("vex_annotations_finding_idx").on(t.findingId)],
);

/** Per-org/repo scan gating policy. mode=audit serves now; mode=enforce blocks until clean. */
export const scanPolicies = pgTable(
  "scan_policies",
  {
    id: primaryId(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryPattern: text().notNull().default("*"),
    mode: policyModeEnum().notNull().default("audit"),
    blockOnSeverity: severityEnum(),
    blockOnMalware: text().notNull().default("true"),
    denyLicenses: text().array(),
    maxCvss: doublePrecision(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("scan_policies_org_pattern_uq").on(t.orgId, t.repositoryPattern),
    index("scan_policies_org_idx").on(t.orgId),
  ],
);

export const osvCache = pgTable(
  "osv_cache",
  {
    id: primaryId(),
    ecosystem: text().notNull(),
    packageName: text().notNull(),
    version: text().notNull(),
    response: jsonb().$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("osv_cache_uq").on(t.ecosystem, t.packageName, t.version)],
);

export const scannerDbState = pgTable("scanner_db_state", {
  scanner: text().primaryKey(),
  dbVersion: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
