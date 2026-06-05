import {
  and,
  artifacts,
  count,
  db,
  desc,
  eq,
  findings,
  isNull,
  packages,
  packageVersions,
  repositories,
} from "@hootifactory/db";
import type { Severity } from "@hootifactory/scan-core";

export type InventoryPackageRow = typeof packages.$inferSelect;
export type InventoryRepositoryRow = typeof repositories.$inferSelect;
export type InventoryArtifactRow = typeof artifacts.$inferSelect;
export type InventoryFindingRow = typeof findings.$inferSelect;

export interface PackageWithRepositoryRow {
  pkg: InventoryPackageRow;
  repo: InventoryRepositoryRow;
}

export interface ArtifactWithRepositoryRow {
  art: InventoryArtifactRow;
  repo: InventoryRepositoryRow;
}

export interface InventoryPageInput {
  limit: number;
  offset: number;
}

export interface PackageListRow {
  id: string;
  name: string;
  latestVersion: string | null;
}

export interface PackageVersionSummaryRow {
  version: string;
  sizeBytes: number;
  createdAt: Date;
}

export type ArtifactListRow = Pick<
  InventoryArtifactRow,
  "id" | "digest" | "name" | "version" | "state" | "policyDecision" | "createdAt"
>;

export type ArtifactFindingRow = Pick<
  InventoryFindingRow,
  "vulnId" | "type" | "severity" | "packageName" | "packageVersion" | "fixedVersion" | "title"
>;

export async function countRepositoryPackages(repositoryId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(packages)
    .where(eq(packages.repositoryId, repositoryId));
  return rows[0]?.value ?? 0;
}

export async function listRepositoryPackageSummaries(
  repositoryId: string,
  page?: InventoryPageInput,
): Promise<PackageListRow[]> {
  const query = () =>
    db
      .select({ id: packages.id, name: packages.name, latestVersion: packages.latestVersion })
      .from(packages)
      .where(eq(packages.repositoryId, repositoryId))
      .orderBy(packages.name);
  return page ? query().limit(page.limit).offset(page.offset) : query();
}

export async function getPackageWithRepository(
  packageId: string,
): Promise<PackageWithRepositoryRow | null> {
  const [row] = await db
    .select({ pkg: packages, repo: repositories })
    .from(packages)
    .innerJoin(repositories, eq(packages.repositoryId, repositories.id))
    .where(eq(packages.id, packageId))
    .limit(1);
  return row ?? null;
}

export async function listLivePackageVersionSummaries(
  packageId: string,
  page?: InventoryPageInput,
): Promise<PackageVersionSummaryRow[]> {
  const query = () =>
    db
      .select({
        version: packageVersions.version,
        sizeBytes: packageVersions.sizeBytes,
        createdAt: packageVersions.createdAt,
      })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)))
      .orderBy(desc(packageVersions.createdAt));
  return page ? query().limit(page.limit).offset(page.offset) : query();
}

export async function countLivePackageVersions(packageId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
  return rows[0]?.value ?? 0;
}

export async function listRepositoryArtifactSummaries(
  repositoryId: string,
  page?: InventoryPageInput,
): Promise<ArtifactListRow[]> {
  const query = () =>
    db
      .select({
        id: artifacts.id,
        digest: artifacts.digest,
        name: artifacts.name,
        version: artifacts.version,
        state: artifacts.state,
        policyDecision: artifacts.policyDecision,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(eq(artifacts.repositoryId, repositoryId))
      .orderBy(desc(artifacts.createdAt));
  return page ? query().limit(page.limit).offset(page.offset) : query();
}

export async function countRepositoryArtifacts(repositoryId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(artifacts)
    .where(eq(artifacts.repositoryId, repositoryId));
  return rows[0]?.value ?? 0;
}

export async function getArtifactWithRepository(
  artifactId: string,
): Promise<ArtifactWithRepositoryRow | null> {
  const [row] = await db
    .select({ art: artifacts, repo: repositories })
    .from(artifacts)
    .innerJoin(repositories, eq(artifacts.repositoryId, repositories.id))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  return row ?? null;
}

function artifactFindingsWhere(artifactId: string, severity?: Severity) {
  return and(
    eq(findings.artifactId, artifactId),
    severity ? eq(findings.severity, severity) : undefined,
  );
}

export async function countArtifactFindings(
  artifactId: string,
  input: { severity?: Severity } = {},
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(findings)
    .where(artifactFindingsWhere(artifactId, input.severity));
  return rows[0]?.value ?? 0;
}

export async function listArtifactFindings(
  artifactId: string,
  input: (InventoryPageInput & { severity?: Severity }) | { severity?: Severity } = {},
): Promise<ArtifactFindingRow[]> {
  const query = () =>
    db
      .select({
        vulnId: findings.vulnId,
        type: findings.type,
        severity: findings.severity,
        packageName: findings.packageName,
        packageVersion: findings.packageVersion,
        fixedVersion: findings.fixedVersion,
        title: findings.title,
      })
      .from(findings)
      .where(artifactFindingsWhere(artifactId, input.severity))
      .orderBy(desc(findings.createdAt), findings.id);
  return "limit" in input ? query().limit(input.limit).offset(input.offset) : query();
}
