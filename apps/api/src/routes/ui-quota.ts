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
  sql,
} from "@hootifactory/db";

export type OrgQuotaLimits = {
  maxStorageBytes: number | null;
  maxArtifacts: number | null;
};

export type OrgQuotaUsage = {
  usedStorageBytes: number;
  usedArtifacts: number;
};

export async function calculateOrgQuotaUsage(orgId: string): Promise<OrgQuotaUsage> {
  const [storageAgg] = await db
    .select({ used: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
    .from(blobs)
    .where(
      sql`${blobs.digest} in (select distinct ${blobRefs.digest} from ${blobRefs} join ${repositories} on ${blobRefs.repositoryId} = ${repositories.id} where ${repositories.orgId} = ${orgId})`,
    );
  const [artifactAgg] = await db
    .select({ used: count() })
    .from(packageVersions)
    .where(eq(packageVersions.orgId, orgId));

  return {
    usedStorageBytes: Number(storageAgg?.used ?? 0),
    usedArtifacts: artifactAgg?.used ?? 0,
  };
}

export async function upsertOrgQuota(
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
