import {
  and,
  blobRefs,
  blobs,
  count,
  db,
  eq,
  isNull,
  packageVersions,
  quotas,
  repositories,
  scanPolicies,
  sql,
} from "@hootifactory/db";
import type { Severity } from "@hootifactory/scan-core";

export type ScanPolicyRow = typeof scanPolicies.$inferSelect;

export type UpsertScanPolicyInput = {
  orgId: string;
  repositoryPattern: string;
  mode: "audit" | "enforce";
  blockOnSeverity: Severity | null;
};

export type OrgQuotaLimits = {
  maxStorageBytes: number | null;
  maxArtifacts: number | null;
};

export type OrgQuotaUsage = {
  usedStorageBytes: number;
  usedArtifacts: number;
};

export type OrgQuotaState = OrgQuotaLimits & OrgQuotaUsage;

export async function upsertScanPolicy(input: UpsertScanPolicyInput): Promise<ScanPolicyRow> {
  const [row] = await db
    .insert(scanPolicies)
    .values({
      orgId: input.orgId,
      repositoryPattern: input.repositoryPattern,
      mode: input.mode,
      blockOnSeverity: input.blockOnSeverity,
    })
    .onConflictDoUpdate({
      target: [scanPolicies.orgId, scanPolicies.repositoryPattern],
      set: {
        mode: input.mode,
        blockOnSeverity: input.blockOnSeverity,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("scan policy upsert did not return a row");
  return row;
}

export async function getOrgQuota(orgId: string): Promise<OrgQuotaState> {
  const [q] = await db
    .select()
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  return {
    maxStorageBytes: q?.maxStorageBytes ?? null,
    usedStorageBytes: q?.usedStorageBytes ?? 0,
    maxArtifacts: q?.maxArtifacts ?? null,
    usedArtifacts: q?.usedArtifacts ?? 0,
  };
}

export async function setOrgQuota(orgId: string, limits: OrgQuotaLimits): Promise<OrgQuotaState> {
  const usage = await calculateOrgQuotaUsage(orgId);
  await upsertOrgQuota(orgId, limits, usage);
  return { ...limits, ...usage };
}

export async function calculateOrgQuotaUsage(orgId: string): Promise<OrgQuotaUsage> {
  const orgBlobDigests = db
    .selectDistinct({ digest: blobRefs.digest })
    .from(blobRefs)
    .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
    .where(eq(repositories.orgId, orgId))
    .as("org_blob_digests");
  const [storageRows, artifactRows] = await Promise.all([
    db
      .select({ used: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
      .from(orgBlobDigests)
      .innerJoin(blobs, eq(orgBlobDigests.digest, blobs.digest)),
    db
      .select({ used: count() })
      .from(packageVersions)
      .where(and(eq(packageVersions.orgId, orgId), isNull(packageVersions.deletedAt))),
  ]);
  const storageAgg = storageRows[0];
  const artifactAgg = artifactRows[0];

  return {
    usedStorageBytes: Number(storageAgg?.used ?? 0),
    usedArtifacts: artifactAgg?.used ?? 0,
  };
}

async function upsertOrgQuota(
  orgId: string,
  limits: OrgQuotaLimits,
  usage: OrgQuotaUsage,
): Promise<void> {
  const [existing] = await db
    .select({ id: quotas.id })
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  const values = { ...limits, ...usage };
  if (existing) {
    await db.update(quotas).set(values).where(eq(quotas.id, existing.id));
    return;
  }
  await db.insert(quotas).values({ orgId, ...values });
}
