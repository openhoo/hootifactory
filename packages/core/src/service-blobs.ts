import { and, blobRefs, blobs, eq, repositories, sql } from "@hootifactory/db";
import { type BlobStore, computeDigest } from "@hootifactory/storage";
import { Errors } from "./errors";
import type { RepoContext } from "./format/adapter";
import {
  adjustStorageUsedTx,
  assertStorageQuota,
  assertStorageQuotaRowAllows,
  lockOrgQuotaTx,
  orgAlreadyReferencesDigestTx,
  type Tx,
} from "./service-quota";

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

type BlobLifecycleContext = { db: RepoContext["db"]; blobs: BlobStore };

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
  ctx: BlobLifecycleContext,
  put: { digest: string; deduped: boolean } | null,
): Promise<void> {
  if (!put || put.deduped) return;
  try {
    await ctx.db.transaction(async (tx) => {
      await lockDigestTx(tx, put.digest);
      const [row] = await tx
        .select({ digest: blobs.digest })
        .from(blobs)
        .where(eq(blobs.digest, put.digest))
        .limit(1);
      if (row) return;
      await ctx.blobs.delete(put.digest).catch(() => {});
    });
  } catch {
    // Best-effort rollback cleanup; DB correctness must not depend on S3 cleanup.
  }
}

export async function deleteUnreferencedCasBlob(
  ctx: BlobLifecycleContext,
  digest: string,
): Promise<void> {
  try {
    await ctx.db.transaction(async (tx) => {
      await lockDigestTx(tx, digest);
      const deleted = await tx
        .delete(blobs)
        .where(
          and(eq(blobs.digest, digest), eq(blobs.refCount, 0), eq(blobs.state, "pending_delete")),
        )
        .returning({ digest: blobs.digest });
      if (deleted.length === 0) return;
      await ctx.blobs.delete(digest).catch(() => {});
    });
  } catch {
    // Reclaim is best-effort; a later retention/delete pass can retry.
  }
}

export async function discardUncommittedBlobPut(
  ctx: BlobLifecycleContext,
  put: { digest: string; deduped: boolean } | null,
): Promise<void> {
  await deleteUnrecordedCasBlob(ctx, put);
}

export async function ensureActiveBlobTx(
  tx: Tx,
  ctx: RepoContext,
  put: BlobPut,
  mediaType?: string,
): Promise<void> {
  const created = await tx
    .insert(blobs)
    .values({
      digest: put.digest,
      sizeBytes: put.size,
      storageKey: ctx.blobs.blobKey(put.digest),
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
  ctx: RepoContext,
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
  ctx: RepoContext,
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

/**
 * Run a store-with-ref transaction: `acquire` performs the per-variant lock +
 * CAS put (registering the put for rollback cleanup the moment it lands), then
 * the shared `commitBlobPutTx` body runs. On any failure the uncommitted CAS put
 * is discarded (best-effort).
 */
async function runStoreBlobWithRef(
  ctx: RepoContext,
  opts: { mediaType?: string; kind: BlobRefKind; scope: string },
  acquire: (tx: Tx, registerCleanup: (put: BlobPutResult) => void) => Promise<BlobPutResult>,
): Promise<StoredBlob> {
  let putForCleanup: BlobPutResult | null = null;
  try {
    return await ctx.db.transaction(async (tx) => {
      const put = await acquire(tx, (p) => {
        putForCleanup = p;
      });
      return commitBlobPutTx(tx, ctx, put, opts);
    });
  } catch (err) {
    await discardUncommittedBlobPut(ctx, putForCleanup);
    throw err;
  }
}

export async function storeBlobWithRef(
  ctx: RepoContext,
  opts: { data: Uint8Array; mediaType?: string; kind: BlobRefKind; scope: string },
): Promise<StoredBlob> {
  const digest = computeDigest(opts.data);
  const [existingOrgRef] = await ctx.db
    .select({ id: blobRefs.id })
    .from(blobRefs)
    .innerJoin(repositories, eq(blobRefs.repositoryId, repositories.id))
    .where(and(eq(repositories.orgId, ctx.repo.orgId), eq(blobRefs.digest, digest)))
    .limit(1);
  if (!existingOrgRef) await assertStorageQuota(ctx, opts.data.byteLength);
  return runStoreBlobWithRef(ctx, opts, async (tx, registerCleanup) => {
    await lockDigestTx(tx, digest);
    const put = await ctx.blobs.put(opts.data);
    registerCleanup(put);
    return put;
  });
}

export async function storeBlobStreamWithRef(
  ctx: RepoContext,
  opts: {
    data: ReadableStream<Uint8Array>;
    expectedDigest?: string;
    mediaType?: string;
    kind: BlobRefKind;
    scope: string;
  },
): Promise<StoredBlob> {
  return runStoreBlobWithRef(ctx, opts, async (tx, registerCleanup) => {
    if (opts.expectedDigest) await lockDigestTx(tx, opts.expectedDigest);
    const put = await ctx.blobs.putStream(opts.data, opts.expectedDigest);
    registerCleanup(put);
    if (!opts.expectedDigest) await lockDigestTx(tx, put.digest);
    return put;
  });
}

export async function ensureBlobRef(
  ctx: RepoContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
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

export async function releaseBlobRef(
  ctx: RepoContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<void> {
  let maybeDeleteCasDigest: string | null = null;
  try {
    await ctx.db.transaction(async (tx) => {
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
