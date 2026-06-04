import { Errors } from "@hootifactory/core";
import { and, blobRefs, blobs, db, eq, repositories, sql } from "@hootifactory/db";
import {
  computeDigest,
  type RegistryReferencedBlob,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import {
  adjustStorageUsedTx,
  assertStorageQuota,
  assertStorageQuotaRowAllows,
  lockOrgQuotaTx,
  orgAlreadyReferencesDigestTx,
  type Tx,
} from "../governance/quota";

export type BlobRefKind =
  | "oci_layer"
  | "oci_config"
  | "oci_manifest"
  | "npm_tarball"
  | "pypi_file"
  | "generic_file";

export interface StoredBlob {
  digest: string;
  size: number;
  deduped: boolean;
  refCreated: boolean;
}

interface BlobPut {
  digest: string;
  size: number;
}

interface BlobPutResult extends BlobPut {
  deduped: boolean;
}

type BlobLifecycleContext = unknown;

export interface BlobGcSweepResult {
  candidates: number;
  reclaimed: number;
}

function rowsFromExecute(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function stringField(row: unknown, field: string): string | null {
  if (!row || typeof row !== "object") return null;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

export async function lockDigestTx(tx: Tx, digest: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${digest}, 0))`);
}

/** Acquire advisory xact locks for a deduped, sorted set of digests (deadlock-safe ordering). */
export async function lockDigestsTx(tx: Tx, digests: string[]): Promise<void> {
  const locks = [...new Set(digests)].sort();
  for (const digest of locks) {
    await lockDigestTx(tx, digest);
  }
}

async function deleteUnrecordedCasBlob(
  _ctx: BlobLifecycleContext,
  put: { digest: string; deduped: boolean } | null,
): Promise<void> {
  if (!put || put.deduped) return;
  try {
    await db.transaction(async (tx) => {
      await lockDigestTx(tx, put.digest);
      const [row] = await tx
        .select({ digest: blobs.digest })
        .from(blobs)
        .where(eq(blobs.digest, put.digest))
        .limit(1);
      if (row) return;
      await blobStore.delete(put.digest).catch(() => {});
    });
  } catch {
    // Best-effort rollback cleanup; DB correctness must not depend on S3 cleanup.
  }
}

async function reclaimUnreferencedCasBlob(digest: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockDigestTx(tx, digest);
    const [row] = await tx
      .select({ digest: blobs.digest })
      .from(blobs)
      .where(
        and(eq(blobs.digest, digest), eq(blobs.refCount, 0), eq(blobs.state, "pending_delete")),
      )
      .limit(1);
    if (!row) return false;
    await blobStore.delete(digest);
    const deleted = await tx
      .delete(blobs)
      .where(
        and(eq(blobs.digest, digest), eq(blobs.refCount, 0), eq(blobs.state, "pending_delete")),
      )
      .returning({ digest: blobs.digest });
    return deleted.length > 0;
  });
}

export async function deleteUnreferencedCasBlob(
  _ctx: BlobLifecycleContext,
  digest: string,
): Promise<void> {
  try {
    await reclaimUnreferencedCasBlob(digest);
  } catch {
    // Reclaim is best-effort; a later retention/delete pass can retry.
  }
}

export async function sweepUnreferencedCasBlobs(opts: {
  limit: number;
  graceMs: number;
}): Promise<BlobGcSweepResult> {
  const cutoff = new Date(Date.now() - opts.graceMs);
  const candidates = rowsFromExecute(
    await db.execute(sql`
      with candidates as (
        select digest
        from blobs
        where ref_count = 0
          and state = 'pending_delete'
          and (pending_since is null or pending_since <= ${cutoff})
        order by pending_since asc nulls first, digest asc
        limit ${opts.limit}
        for update skip locked
      )
      select digest from candidates
    `),
  ).flatMap((row) => {
    const digest = stringField(row, "digest");
    return digest ? [digest] : [];
  });

  let reclaimed = 0;
  for (const digest of candidates) {
    if (await reclaimUnreferencedCasBlob(digest).catch(() => false)) reclaimed += 1;
  }
  return { candidates: candidates.length, reclaimed };
}

export async function discardUncommittedBlobPut(
  ctx: BlobLifecycleContext,
  put: { digest: string; deduped: boolean } | null,
): Promise<void> {
  await deleteUnrecordedCasBlob(ctx, put);
}

export async function ensureActiveBlobTx(
  tx: Tx,
  _ctx: RegistryRequestContext,
  put: BlobPut,
  mediaType?: string,
): Promise<void> {
  const created = await tx
    .insert(blobs)
    .values({
      digest: put.digest,
      sizeBytes: put.size,
      storageKey: blobStore.blobKey(put.digest),
      mediaType: mediaType ?? null,
      refCount: 0,
      state: "active",
    })
    .onConflictDoNothing()
    .returning({ digest: blobs.digest });
  if (created.length === 0) {
    await tx
      .update(blobs)
      .set({ state: "active", pendingSince: null })
      .where(and(eq(blobs.digest, put.digest), eq(blobs.state, "pending_delete")));
  }
}

export async function insertBlobRefTx(
  tx: Tx,
  ctx: RegistryRequestContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<boolean> {
  const refRows = await tx
    .insert(blobRefs)
    .values({
      digest: ref.digest,
      kind: ref.kind,
      repositoryId: ctx.repo.id,
      scope: ref.scope,
    })
    .onConflictDoNothing()
    .returning({ id: blobRefs.id });
  return refRows.length > 0;
}

export async function incrementBlobRefCountTx(tx: Tx, digest: string): Promise<void> {
  await tx
    .update(blobs)
    .set({ refCount: sql`${blobs.refCount} + 1` })
    .where(eq(blobs.digest, digest));
}

/**
 * Shared post-put transaction body for the store-with-ref paths: lock the org
 * quota, charge it only if the org does not already reference the digest, ensure
 * the blob row is active, insert the repo ref, and bump refCount/usage. The CAS
 * put must already have happened (its result is passed in as `put`).
 */
async function commitBlobPutTx(
  tx: Tx,
  ctx: RegistryRequestContext,
  put: BlobPutResult,
  opts: { mediaType?: string; kind: BlobRefKind; scope: string },
): Promise<StoredBlob> {
  const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
  const chargeOrg = !(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, put.digest));
  if (chargeOrg) assertStorageQuotaRowAllows(quota, put.size);

  await ensureActiveBlobTx(tx, ctx, put, opts.mediaType);
  const refCreated = await insertBlobRefTx(tx, ctx, {
    digest: put.digest,
    kind: opts.kind,
    scope: opts.scope,
  });
  if (refCreated) {
    await incrementBlobRefCountTx(tx, put.digest);
    if (chargeOrg) await adjustStorageUsedTx(tx, ctx.repo.orgId, put.size);
  }
  return {
    digest: put.digest,
    size: put.size,
    deduped: put.deduped,
    refCreated,
  };
}

export async function uploadBlobStream(
  data: ReadableStream<Uint8Array>,
  expectedDigest?: string,
): Promise<BlobPutResult> {
  return blobStore.putStream(data, expectedDigest);
}

export async function commitUploadedBlobRefTx(
  tx: Tx,
  ctx: RegistryRequestContext,
  put: BlobPutResult,
  opts: { mediaType?: string; kind: BlobRefKind; scope: string },
): Promise<StoredBlob> {
  await lockDigestTx(tx, put.digest);
  return commitBlobPutTx(tx, ctx, put, opts);
}

export async function storeBlobWithRef(
  ctx: RegistryRequestContext,
  opts: { data: Uint8Array; mediaType?: string; kind: BlobRefKind; scope: string },
): Promise<StoredBlob> {
  const digest = computeDigest(opts.data);
  const [existingOrgRef] = await db
    .select({ id: blobRefs.id })
    .from(blobRefs)
    .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
    .where(and(eq(repositories.orgId, ctx.repo.orgId), eq(blobRefs.digest, digest)))
    .limit(1);
  if (!existingOrgRef) await assertStorageQuota(ctx, opts.data.byteLength);
  const put = await blobStore.put(opts.data, digest);
  try {
    return await db.transaction((tx) => commitUploadedBlobRefTx(tx, ctx, put, opts));
  } catch (err) {
    await discardUncommittedBlobPut(ctx, put);
    throw err;
  }
}

export async function storeBlobStreamWithRef(
  ctx: RegistryRequestContext,
  opts: {
    data: ReadableStream<Uint8Array>;
    expectedDigest?: string;
    mediaType?: string;
    kind: BlobRefKind;
    scope: string;
  },
): Promise<StoredBlob> {
  const put = await uploadBlobStream(opts.data, opts.expectedDigest);
  try {
    return await db.transaction((tx) => commitUploadedBlobRefTx(tx, ctx, put, opts));
  } catch (err) {
    await discardUncommittedBlobPut(ctx, put);
    throw err;
  }
}

export async function ensureBlobRef(
  ctx: RegistryRequestContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [b] = await tx
      .select({ size: blobs.sizeBytes })
      .from(blobs)
      .where(eq(blobs.digest, ref.digest))
      .limit(1);
    if (!b) throw Errors.blobUnknown({ digest: ref.digest });

    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    const chargeOrg = !(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, ref.digest));
    if (chargeOrg) assertStorageQuotaRowAllows(quota, b.size);

    const refCreated = await insertBlobRefTx(tx, ctx, ref);
    if (!refCreated) return;

    await tx
      .update(blobs)
      .set({
        refCount: sql`${blobs.refCount} + 1`,
        state: "active",
        pendingSince: null,
      })
      .where(eq(blobs.digest, ref.digest));
    if (chargeOrg) await adjustStorageUsedTx(tx, ctx.repo.orgId, b.size);
  });
}

export async function blobRefExists(
  ctx: RegistryRequestContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: blobRefs.id })
    .from(blobRefs)
    .where(
      and(
        eq(blobRefs.repositoryId, ctx.repo.id),
        eq(blobRefs.digest, ref.digest),
        eq(blobRefs.kind, ref.kind),
        eq(blobRefs.scope, ref.scope),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function getBlobRef(
  ctx: RegistryRequestContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<RegistryReferencedBlob | null> {
  const [row] = await db
    .select({ size: blobs.sizeBytes })
    .from(blobRefs)
    .innerJoin(blobs, eq(blobRefs.digest, blobs.digest))
    .where(
      and(
        eq(blobRefs.repositoryId, ctx.repo.id),
        eq(blobRefs.digest, ref.digest),
        eq(blobRefs.kind, ref.kind),
        eq(blobRefs.scope, ref.scope),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    digest: ref.digest,
    size: row.size,
    get: () => blobStore.get(ref.digest),
    getRange: (start, end) => blobStore.getRange(ref.digest, start, end),
  };
}

export async function releaseBlobRef(
  ctx: RegistryRequestContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<void> {
  let maybeDeleteCasDigest: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await lockDigestTx(tx, ref.digest);
      const deleted = await tx
        .delete(blobRefs)
        .where(
          and(
            eq(blobRefs.digest, ref.digest),
            eq(blobRefs.kind, ref.kind),
            eq(blobRefs.repositoryId, ctx.repo.id),
            eq(blobRefs.scope, ref.scope),
          ),
        )
        .returning({ id: blobRefs.id });
      if (deleted.length === 0) return;

      const [b] = await tx
        .select({ refCount: blobs.refCount, size: blobs.sizeBytes })
        .from(blobs)
        .where(eq(blobs.digest, ref.digest))
        .limit(1);
      if (!b) return;

      if (!(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, ref.digest))) {
        await adjustStorageUsedTx(tx, ctx.repo.orgId, -b.size);
      }
      maybeDeleteCasDigest = ref.digest;
    });
  } catch {
    maybeDeleteCasDigest = null;
  }
  if (maybeDeleteCasDigest) await deleteUnreferencedCasBlob(ctx, maybeDeleteCasDigest);
}

export async function releaseRepoDigestTx(
  tx: Tx,
  opts: { repositoryId: string; orgId: string; digest: string },
): Promise<string | null> {
  await lockDigestTx(tx, opts.digest);
  const deleted = await tx
    .delete(blobRefs)
    .where(and(eq(blobRefs.repositoryId, opts.repositoryId), eq(blobRefs.digest, opts.digest)))
    .returning({ id: blobRefs.id });
  if (deleted.length === 0) return null;
  const [b] = await tx
    .select({ refCount: blobs.refCount, size: blobs.sizeBytes })
    .from(blobs)
    .where(eq(blobs.digest, opts.digest))
    .limit(1);
  if (!b) return null;
  if (!(await orgAlreadyReferencesDigestTx(tx, opts.orgId, opts.digest))) {
    await adjustStorageUsedTx(tx, opts.orgId, -b.size);
  }
  return b.refCount <= 0 ? opts.digest : null;
}
