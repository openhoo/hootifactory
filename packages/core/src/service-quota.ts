import { and, blobRefs, eq, isNull, quotas, repositories, sql } from "@hootifactory/db";
import { Errors } from "./errors";
import type { RepoContext } from "./format/adapter";

export type Tx = Parameters<Parameters<RepoContext["db"]["transaction"]>[0]>[0];

function orgQuotaWhere(orgId: string) {
  return and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId));
}

/**
 * Lock the org quota row inside a transaction so quota check + usage update is
 * serialized for concurrent uploads.
 */
export async function lockOrgQuotaTx(tx: Tx, orgId: string) {
  const [q] = await tx
    .select({
      used: quotas.usedStorageBytes,
      max: quotas.maxStorageBytes,
      usedArtifacts: quotas.usedArtifacts,
      maxArtifacts: quotas.maxArtifacts,
    })
    .from(quotas)
    .where(orgQuotaWhere(orgId))
    .for("update")
    .limit(1);
  return q ?? null;
}

export function assertStorageQuotaRowAllows(
  q: { used: number; max: number | null } | null,
  addBytes: number,
): void {
  if (q?.max != null && q.used + addBytes > q.max) {
    throw Errors.quotaExceeded({ max: q.max, used: q.used, requested: addBytes });
  }
}

export function assertArtifactQuotaRowAllows(
  q: { usedArtifacts: number; maxArtifacts: number | null } | null,
  addArtifacts: number,
): void {
  if (q?.maxArtifacts != null && q.usedArtifacts + addArtifacts > q.maxArtifacts) {
    throw Errors.quotaExceeded({
      maxArtifacts: q.maxArtifacts,
      usedArtifacts: q.usedArtifacts,
      requestedArtifacts: addArtifacts,
    });
  }
}

export async function assertStorageQuota(ctx: RepoContext, addBytes: number): Promise<void> {
  const [q] = await ctx.db
    .select({ used: quotas.usedStorageBytes, max: quotas.maxStorageBytes })
    .from(quotas)
    .where(orgQuotaWhere(ctx.repo.orgId))
    .limit(1);
  assertStorageQuotaRowAllows(q ?? null, addBytes);
}

export async function orgAlreadyReferencesDigestTx(
  tx: Tx,
  orgId: string,
  digest: string,
): Promise<boolean> {
  const [ref] = await tx
    .select({ id: blobRefs.id })
    .from(blobRefs)
    .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
    .where(and(eq(repositories.orgId, orgId), eq(blobRefs.digest, digest)))
    .limit(1);
  return Boolean(ref);
}

export async function adjustStorageUsedTx(tx: Tx, orgId: string, delta: number): Promise<void> {
  await tx
    .update(quotas)
    .set({ usedStorageBytes: sql`GREATEST(0, ${quotas.usedStorageBytes} + ${delta})` })
    .where(orgQuotaWhere(orgId));
}

export async function adjustArtifactsUsedTx(tx: Tx, orgId: string, delta: number): Promise<void> {
  await tx
    .update(quotas)
    .set({ usedArtifacts: sql`GREATEST(0, ${quotas.usedArtifacts} + ${delta})` })
    .where(orgQuotaWhere(orgId));
}
