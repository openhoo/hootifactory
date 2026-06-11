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
import { lockOrgQuotaTx, type Tx } from "./quota";
import { invalidateRegistryScanPolicyCache } from "./scan-policy";

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
  invalidateRegistryScanPolicyCache(input.orgId);
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
  // The publish/delete paths serialize quota mutations by taking the org quota
  // row's FOR UPDATE lock and applying an incremental delta. setOrgQuota instead
  // recomputes usage from scratch and writes absolute values, so it must take the
  // same lock — otherwise a concurrent locked adjust can be silently overwritten,
  // permanently drifting usage below true usage. Recompute + write run inside the
  // lock-holding transaction so the absolute write reflects a consistent snapshot.
  return db.transaction(async (tx) => {
    await lockOrgQuotaTx(tx, orgId);
    const usage = await calculateOrgQuotaUsage(tx, orgId);
    await upsertOrgQuota(tx, orgId, limits, usage);
    return { ...limits, ...usage };
  });
}

export async function calculateOrgQuotaUsage(tx: Tx, orgId: string): Promise<OrgQuotaUsage> {
  const orgBlobDigests = tx
    .selectDistinct({ digest: blobRefs.digest })
    .from(blobRefs)
    .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
    .where(eq(repositories.orgId, orgId))
    .as("org_blob_digests");
  // Sequential (not Promise.all): both run on the transaction's single connection.
  const storageRows = await tx
    .select({ used: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
    .from(orgBlobDigests)
    .innerJoin(blobs, eq(orgBlobDigests.digest, blobs.digest));
  const artifactRows = await tx
    .select({ used: count() })
    .from(packageVersions)
    .where(and(eq(packageVersions.orgId, orgId), isNull(packageVersions.deletedAt)));
  const storageAgg = storageRows[0];
  const artifactAgg = artifactRows[0];

  return {
    usedStorageBytes: Number(storageAgg?.used ?? 0),
    usedArtifacts: artifactAgg?.used ?? 0,
  };
}

async function upsertOrgQuota(
  tx: Tx,
  orgId: string,
  limits: OrgQuotaLimits,
  usage: OrgQuotaUsage,
): Promise<void> {
  const values = { ...limits, ...usage };
  // Single atomic upsert on the partial unique index (org-level row is unique on
  // orgId where repositoryId IS NULL) so two concurrent first-time sets cannot both
  // insert a duplicate org row.
  await tx
    .insert(quotas)
    .values({ orgId, ...values })
    .onConflictDoUpdate({
      target: quotas.orgId,
      targetWhere: isNull(quotas.repositoryId),
      set: values,
    });
}
