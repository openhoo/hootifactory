import {
  and,
  artifacts,
  blobRefs,
  blobs,
  eq,
  isNull,
  packageVersions,
  quotas,
  repositories,
  scanPolicies,
  sql,
  versionTags,
} from "@hootifactory/db";
import { resolveScanPolicy } from "@hootifactory/scan-core";
import { computeDigest } from "@hootifactory/storage";
import { Errors } from "./errors";
import type { RepoContext } from "./format/adapter";

/** A transaction handle (or the base db) — accepted by the in-transaction helpers. */
type Tx = Parameters<Parameters<RepoContext["db"]["transaction"]>[0]>[0];

/**
 * Enforce an org storage quota, row-locked, inside a transaction (opt-in: only
 * when a quota row with a max is set). Taking the lock serializes concurrent
 * uploads for the org so the check + the usage bump cannot race.
 */
async function lockOrgQuotaTx(tx: Tx, orgId: string) {
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

function assertStorageQuotaRowAllows(
  q: { used: number; max: number | null } | null,
  addBytes: number,
): void {
  if (q?.max != null && q.used + addBytes > q.max) {
    throw Errors.quotaExceeded({ max: q.max, used: q.used, requested: addBytes });
  }
}

function assertArtifactQuotaRowAllows(
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

/** Best-effort (non-locking) pre-check so a clearly-over-quota upload never touches S3. */
async function assertStorageQuota(ctx: RepoContext, addBytes: number): Promise<void> {
  const [q] = await ctx.db
    .select({ used: quotas.usedStorageBytes, max: quotas.maxStorageBytes })
    .from(quotas)
    .where(and(eq(quotas.orgId, ctx.repo.orgId), isNull(quotas.repositoryId)))
    .limit(1);
  if (q?.max != null && q.used + addBytes > q.max) {
    throw Errors.quotaExceeded({ max: q.max, used: q.used, requested: addBytes });
  }
}

async function orgAlreadyReferencesDigestTx(
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

/** Adjust org used-storage by `delta` bytes, clamped at zero. */
async function adjustStorageUsedTx(tx: Tx, orgId: string, delta: number): Promise<void> {
  await tx
    .update(quotas)
    .set({ usedStorageBytes: sql`GREATEST(0, ${quotas.usedStorageBytes} + ${delta})` })
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)));
}

async function adjustArtifactsUsedTx(tx: Tx, orgId: string, delta: number): Promise<void> {
  await tx
    .update(quotas)
    .set({ usedArtifacts: sql`GREATEST(0, ${quotas.usedArtifacts} + ${delta})` })
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)));
}

/** True if a published artifact (by digest, in this repo) is policy-blocked. */
export async function isArtifactBlocked(ctx: RepoContext, digest: string): Promise<boolean> {
  const policies = await ctx.db
    .select()
    .from(scanPolicies)
    .where(eq(scanPolicies.orgId, ctx.repo.orgId));
  const policy = resolveScanPolicy(policies, ctx.repo.name);
  const [row] = await ctx.db
    .select({ state: artifacts.state })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, ctx.repo.orgId),
        eq(artifacts.repositoryId, ctx.repo.id),
        eq(artifacts.digest, digest),
      ),
    )
    .limit(1);
  if (row?.state === "blocked") return true;
  // Enforce mode is fail-closed: bytes are unavailable until a scanner has
  // positively marked the artifact clean. This covers pending, failed/retried
  // scans that leave the artifact pending, scanner-disabled repos with no
  // artifact row, and artifacts that predate policy creation.
  if (policy?.mode === "enforce") return row?.state !== "clean";
  return false;
}

/** Audience/service name for OCI Bearer tokens (used by /token + verify + challenge). */
export const REGISTRY_TOKEN_SERVICE = "hootifactory";

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

/**
 * Store bytes in the CAS and record a repo-scoped reference, maintaining
 * ref_count and (opt-in) storage quota transactionally. A duplicate
 * (kind, repo, scope, digest) is a no-op ref.
 *
 * Quota accounting is authoritative and atomic: each org is charged once per
 * distinct digest it references. The quota row is row-locked before the
 * org-reference check so concurrent uploads cannot collectively exceed the
 * limit or double-count a digest already referenced by that org.
 */
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
  // Cheap, best-effort fast-fail so a clearly-over-quota org write never touches S3.
  if (!existingOrgRef) await assertStorageQuota(ctx, opts.data.byteLength);
  const put = await ctx.blobs.put(opts.data);
  let refCreated = false;
  await ctx.db.transaction(async (tx) => {
    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    const chargeOrg = !(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, put.digest));
    if (chargeOrg) assertStorageQuotaRowAllows(quota, put.size);

    const created = await tx
      .insert(blobs)
      .values({
        digest: put.digest,
        sizeBytes: put.size,
        storageKey: ctx.blobs.blobKey(put.digest),
        mediaType: opts.mediaType ?? null,
        refCount: 0,
        state: "active",
      })
      .onConflictDoNothing()
      .returning({ digest: blobs.digest });
    if (created.length === 0) {
      // Existing blob: revive it if a prior delete/cascade left it pending_delete,
      // so a GC sweep can't reap bytes that are being referenced again.
      await tx
        .update(blobs)
        .set({ state: "active", pendingSince: null })
        .where(and(eq(blobs.digest, put.digest), eq(blobs.state, "pending_delete")));
    }
    const refRows = await tx
      .insert(blobRefs)
      .values({
        digest: put.digest,
        kind: opts.kind,
        repositoryId: ctx.repo.id,
        scope: opts.scope,
      })
      .onConflictDoNothing()
      .returning({ id: blobRefs.id });
    if (refRows.length > 0) {
      refCreated = true;
      await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + 1` })
        .where(eq(blobs.digest, put.digest));
      if (chargeOrg) await adjustStorageUsedTx(tx, ctx.repo.orgId, put.size);
    }
  });
  return { ...put, refCreated };
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
  const put = await ctx.blobs.putStream(opts.data, opts.expectedDigest);
  let refCreated = false;
  await ctx.db.transaction(async (tx) => {
    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    const chargeOrg = !(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, put.digest));
    if (chargeOrg) assertStorageQuotaRowAllows(quota, put.size);

    const created = await tx
      .insert(blobs)
      .values({
        digest: put.digest,
        sizeBytes: put.size,
        storageKey: ctx.blobs.blobKey(put.digest),
        mediaType: opts.mediaType ?? null,
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
    const refRows = await tx
      .insert(blobRefs)
      .values({
        digest: put.digest,
        kind: opts.kind,
        repositoryId: ctx.repo.id,
        scope: opts.scope,
      })
      .onConflictDoNothing()
      .returning({ id: blobRefs.id });
    if (refRows.length > 0) {
      refCreated = true;
      await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + 1` })
        .where(eq(blobs.digest, put.digest));
      if (chargeOrg) await adjustStorageUsedTx(tx, ctx.repo.orgId, put.size);
    }
  });
  return { ...put, refCreated };
}

/**
 * Record a repo-scoped reference to an existing CAS blob, maintaining the same
 * per-org quota and ref_count invariants as a normal upload. Used by OCI
 * cross-repo mounts, where the bytes are already present and must not be copied.
 */
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
    if (refRows.length === 0) return;

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

/**
 * Release one repo-scoped blob reference. The AFTER DELETE trigger on blob_refs
 * decrements ref_count (and marks the blob pending_delete at zero). Storage
 * quota is refunded when the org no longer references the digest; CAS bytes are
 * deleted only when the LAST global reference is gone.
 * Idempotent: releasing a non-existent ref is a no-op.
 */
export async function releaseBlobRef(
  ctx: RepoContext,
  ref: { digest: string; kind: BlobRefKind; scope: string },
): Promise<void> {
  let deleteCas = false;
  try {
    await ctx.db.transaction(async (tx) => {
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

      const rows = await tx
        .delete(blobs)
        .where(and(eq(blobs.digest, ref.digest), eq(blobs.refCount, 0)))
        .returning({ digest: blobs.digest });
      deleteCas = rows.length > 0;
    });
  } catch {
    // A concurrent re-reference (FK RESTRICT) — leave the blob for a later pass.
    deleteCas = false;
  }
  if (deleteCas) {
    await ctx.blobs.delete(ref.digest).catch(() => {});
  }
}

/**
 * Release every reference this repo holds for `digest` and reclaim the blob when
 * it becomes globally unreferenced. Runs inside the caller's transaction `tx`;
 * returns the digest to delete from the CAS after commit, or null. Used by
 * retention pruning.
 */
export async function releaseRepoDigestTx(
  tx: Tx,
  opts: { repositoryId: string; orgId: string; digest: string },
): Promise<string | null> {
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
  if (b.refCount > 0) return null;
  const rows = await tx
    .delete(blobs)
    .where(and(eq(blobs.digest, opts.digest), eq(blobs.refCount, 0)))
    .returning({ digest: blobs.digest });
  if (rows.length === 0) return null;
  return opts.digest;
}

/** Resolve the publisher fields from the request principal. */
export function publisherOf(ctx: RepoContext): {
  publishedByUserId: string | null;
  publishedByTokenId: string | null;
} {
  const p = ctx.principal;
  if (p.kind === "user") return { publishedByUserId: p.userId, publishedByTokenId: null };
  if (p.kind === "token")
    return { publishedByUserId: p.ownerUserId, publishedByTokenId: p.tokenId };
  return { publishedByUserId: null, publishedByTokenId: null };
}

export async function upsertPackageVersion(
  ctx: RepoContext,
  opts: {
    packageId: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
  },
): Promise<string> {
  const publisher = publisherOf(ctx);
  return ctx.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, opts.packageId),
          eq(packageVersions.version, opts.version),
        ),
      )
      .for("update")
      .limit(1);
    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    if (!existing) assertArtifactQuotaRowAllows(quota, 1);
    const [row] = await tx
      .insert(packageVersions)
      .values({
        orgId: ctx.repo.orgId,
        packageId: opts.packageId,
        version: opts.version,
        metadata: opts.metadata,
        sizeBytes: opts.sizeBytes,
        ...publisher,
      })
      .onConflictDoUpdate({
        target: [packageVersions.packageId, packageVersions.version],
        set: { metadata: opts.metadata, sizeBytes: opts.sizeBytes, deletedAt: null },
      })
      .returning({ id: packageVersions.id });
    if (!row) throw new Error("failed to upsert package version");
    if (!existing) await adjustArtifactsUsedTx(tx, ctx.repo.orgId, 1);
    return row.id;
  });
}

export async function upsertPackageVersionWithBlobRef(
  ctx: RepoContext,
  opts: {
    packageId: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
    blob: {
      data: Uint8Array;
      mediaType?: string;
      kind: BlobRefKind;
      scope: string;
      previousDigest?: string | null;
    };
  },
): Promise<{ stored: StoredBlob; versionId: string }> {
  const put = await ctx.blobs.put(opts.blob.data);
  const publisher = publisherOf(ctx);
  let refCreated = false;
  let deleteCasDigest: string | null = null;
  let versionId = "";

  await ctx.db.transaction(async (tx) => {
    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    const [existingVersion] = await tx
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, opts.packageId),
          eq(packageVersions.version, opts.version),
        ),
      )
      .for("update")
      .limit(1);
    if (!existingVersion) assertArtifactQuotaRowAllows(quota, 1);
    const previousDigest =
      opts.blob.previousDigest && opts.blob.previousDigest !== put.digest
        ? opts.blob.previousDigest
        : null;
    let oldRefundBytes = 0;

    if (previousDigest) {
      const [oldBlob] = await tx
        .select({ size: blobs.sizeBytes })
        .from(blobs)
        .where(eq(blobs.digest, previousDigest))
        .limit(1);
      const oldDeleted = await tx
        .delete(blobRefs)
        .where(
          and(
            eq(blobRefs.digest, previousDigest),
            eq(blobRefs.kind, opts.blob.kind),
            eq(blobRefs.repositoryId, ctx.repo.id),
            eq(blobRefs.scope, opts.blob.scope),
          ),
        )
        .returning({ id: blobRefs.id });
      if (
        oldBlob &&
        oldDeleted.length > 0 &&
        !(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, previousDigest))
      ) {
        oldRefundBytes = oldBlob.size;
      }
    }

    const chargeOrg = !(await orgAlreadyReferencesDigestTx(tx, ctx.repo.orgId, put.digest));

    const created = await tx
      .insert(blobs)
      .values({
        digest: put.digest,
        sizeBytes: put.size,
        storageKey: ctx.blobs.blobKey(put.digest),
        mediaType: opts.blob.mediaType ?? null,
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

    const refRows = await tx
      .insert(blobRefs)
      .values({
        digest: put.digest,
        kind: opts.blob.kind,
        repositoryId: ctx.repo.id,
        scope: opts.blob.scope,
      })
      .onConflictDoNothing()
      .returning({ id: blobRefs.id });
    refCreated = refRows.length > 0;

    const netDelta = (refCreated && chargeOrg ? put.size : 0) - oldRefundBytes;
    if (netDelta > 0) assertStorageQuotaRowAllows(quota, netDelta);

    if (refCreated) {
      await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + 1` })
        .where(eq(blobs.digest, put.digest));
    }
    if (netDelta !== 0) await adjustStorageUsedTx(tx, ctx.repo.orgId, netDelta);

    const [versionRow] = await tx
      .insert(packageVersions)
      .values({
        orgId: ctx.repo.orgId,
        packageId: opts.packageId,
        version: opts.version,
        metadata: opts.metadata,
        sizeBytes: opts.sizeBytes,
        ...publisher,
      })
      .onConflictDoUpdate({
        target: [packageVersions.packageId, packageVersions.version],
        set: { metadata: opts.metadata, sizeBytes: opts.sizeBytes, deletedAt: null },
      })
      .returning({ id: packageVersions.id });
    if (!versionRow) throw new Error("failed to upsert package version");
    versionId = versionRow.id;
    if (!existingVersion) await adjustArtifactsUsedTx(tx, ctx.repo.orgId, 1);

    if (previousDigest) {
      const rows = await tx
        .delete(blobs)
        .where(and(eq(blobs.digest, previousDigest), eq(blobs.refCount, 0)))
        .returning({ digest: blobs.digest });
      deleteCasDigest = rows[0]?.digest ?? null;
    }
  });

  if (deleteCasDigest) {
    await ctx.blobs.delete(deleteCasDigest).catch(() => {});
  }
  return { stored: { ...put, refCreated }, versionId };
}

export async function createPackageVersion(
  ctx: RepoContext,
  opts: {
    packageId: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
  },
): Promise<string | null> {
  const publisher = publisherOf(ctx);
  return ctx.db.transaction(async (tx) => {
    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    assertArtifactQuotaRowAllows(quota, 1);
    const [row] = await tx
      .insert(packageVersions)
      .values({
        orgId: ctx.repo.orgId,
        packageId: opts.packageId,
        version: opts.version,
        metadata: opts.metadata,
        sizeBytes: opts.sizeBytes,
        ...publisher,
      })
      .onConflictDoNothing()
      .returning({ id: packageVersions.id });
    if (!row) return null;
    await adjustArtifactsUsedTx(tx, ctx.repo.orgId, 1);
    return row.id;
  });
}

export async function setDistTag(
  ctx: RepoContext,
  packageId: string,
  tag: string,
  versionId: string,
): Promise<void> {
  await ctx.db
    .insert(versionTags)
    .values({ packageId, tag, versionId })
    .onConflictDoUpdate({ target: [versionTags.packageId, versionTags.tag], set: { versionId } });
}
