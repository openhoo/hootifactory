import { and, blobRefs, eq, isNull, quotas, repositories, sql } from "@hootifactory/db";
import { Errors } from "./errors";
import type { RepoContext } from "./format/adapter";

export type Tx = Parameters<Parameters<RepoContext["db"]["transaction"]>[0]>[0];

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
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
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
    .where(and(eq(quotas.orgId, ctx.repo.orgId), isNull(quotas.repositoryId)))
    .limit(1);
  if (q?.max != null && q.used + addBytes > q.max) {
    throw Errors.quotaExceeded({ max: q.max, used: q.used, requested: addBytes });
  }
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
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)));
}

export async function adjustArtifactsUsedTx(tx: Tx, orgId: string, delta: number): Promise<void> {
  await tx
    .update(quotas)
    .set({ usedArtifacts: sql`GREATEST(0, ${quotas.usedArtifacts} + ${delta})` })
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)));
}
