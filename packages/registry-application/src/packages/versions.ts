import { and, blobRefs, blobs, db, eq, packageVersions, versionTags } from "@hootifactory/db";
import { computeDigest, type RegistryRequestContext } from "@hootifactory/registry";
import {
  type BlobRefKind,
  deleteUnreferencedCasBlob,
  discardUncommittedBlobPut,
  ensureActiveBlobTx,
  incrementBlobRefCountTx,
  insertBlobRefTx,
  lockDigestsTx,
  releaseBlobRef,
  type StoredBlob,
} from "../content/blobs";
import {
  adjustArtifactsUsedTx,
  adjustStorageUsedTx,
  assertArtifactQuotaRowAllows,
  assertStorageQuotaRowAllows,
  lockOrgQuotaTx,
  orgAlreadyReferencesDigestTx,
} from "../governance/quota";

export function publisherOf(ctx: RegistryRequestContext): {
  publishedByUserId: string | null;
  publishedByTokenId: string | null;
} {
  const p = ctx.principal;
  if (p.kind === "user") return { publishedByUserId: p.userId, publishedByTokenId: null };
  if (p.kind === "token")
    return { publishedByUserId: p.ownerUserId, publishedByTokenId: p.tokenId };
  return { publishedByUserId: null, publishedByTokenId: null };
}

interface PackageVersionInput {
  packageId: string;
  version: string;
  metadata: Record<string, unknown>;
  sizeBytes: number;
}

/** The shared `packageVersions` insert values (org, package, version, metadata, size + publisher). */
function packageVersionValues(
  ctx: RegistryRequestContext,
  opts: PackageVersionInput,
  publisher: ReturnType<typeof publisherOf>,
) {
  return {
    orgId: ctx.repo.orgId,
    packageId: opts.packageId,
    version: opts.version,
    metadata: opts.metadata,
    sizeBytes: opts.sizeBytes,
    ...publisher,
  };
}

/** The shared onConflictDoUpdate config for the (packageId, version) unique key. */
function packageVersionConflictUpdate(opts: PackageVersionInput) {
  return {
    target: [packageVersions.packageId, packageVersions.version],
    set: { metadata: opts.metadata, sizeBytes: opts.sizeBytes, deletedAt: null },
  };
}

export async function upsertPackageVersion(
  ctx: RegistryRequestContext,
  opts: {
    packageId: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
  },
): Promise<string> {
  const publisher = publisherOf(ctx);
  return db.transaction(async (tx) => {
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
      .values(packageVersionValues(ctx, opts, publisher))
      .onConflictDoUpdate(packageVersionConflictUpdate(opts))
      .returning({ id: packageVersions.id });
    if (!row) throw new Error("failed to upsert package version");
    if (!existing) await adjustArtifactsUsedTx(tx, ctx.repo.orgId, 1);
    return row.id;
  });
}

export async function upsertPackageVersionWithBlobRef(
  ctx: RegistryRequestContext,
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
  const digest = computeDigest(opts.blob.data);
  const previousDigestInput =
    opts.blob.previousDigest && opts.blob.previousDigest !== digest
      ? opts.blob.previousDigest
      : null;
  const publisher = publisherOf(ctx);
  let putForCleanup: StoredBlob | null = null;
  let deleteCasAfterCommit: string | null = null;

  try {
    const result = await db.transaction(async (tx) => {
      await lockDigestsTx(
        tx,
        [digest, previousDigestInput].filter((d): d is string => !!d),
      );
      const rawPut = await ctx.blobs.put(opts.blob.data);
      const put = { ...rawPut, refCreated: false };
      putForCleanup = put;
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
      const previousDigest = previousDigestInput;
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

      await ensureActiveBlobTx(tx, ctx, put, opts.blob.mediaType);
      const refCreated = await insertBlobRefTx(tx, ctx, {
        digest: put.digest,
        kind: opts.blob.kind,
        scope: opts.blob.scope,
      });

      const netDelta = (refCreated && chargeOrg ? put.size : 0) - oldRefundBytes;
      if (netDelta > 0) assertStorageQuotaRowAllows(quota, netDelta);

      if (refCreated) await incrementBlobRefCountTx(tx, put.digest);
      if (netDelta !== 0) await adjustStorageUsedTx(tx, ctx.repo.orgId, netDelta);

      const [versionRow] = await tx
        .insert(packageVersions)
        .values(packageVersionValues(ctx, opts, publisher))
        .onConflictDoUpdate(packageVersionConflictUpdate(opts))
        .returning({ id: packageVersions.id });
      if (!versionRow) throw new Error("failed to upsert package version");
      if (!existingVersion) await adjustArtifactsUsedTx(tx, ctx.repo.orgId, 1);

      return {
        deleteCasDigest: previousDigest,
        stored: {
          digest: put.digest,
          size: put.size,
          deduped: put.deduped,
          refCreated,
        },
        versionId: versionRow.id,
      };
    });
    deleteCasAfterCommit = result.deleteCasDigest;
    if (deleteCasAfterCommit) await deleteUnreferencedCasBlob(ctx, deleteCasAfterCommit);
    return { stored: result.stored, versionId: result.versionId };
  } catch (err) {
    if (!deleteCasAfterCommit) await discardUncommittedBlobPut(ctx, putForCleanup);
    throw err;
  }
}

export async function createPackageVersion(
  ctx: RegistryRequestContext,
  opts: {
    packageId: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
  },
): Promise<string | null> {
  const publisher = publisherOf(ctx);
  return db.transaction(async (tx) => {
    const quota = await lockOrgQuotaTx(tx, ctx.repo.orgId);
    const [row] = await tx
      .insert(packageVersions)
      .values(packageVersionValues(ctx, opts, publisher))
      .onConflictDoNothing()
      .returning({ id: packageVersions.id });
    if (!row) return null;
    assertArtifactQuotaRowAllows(quota, 1);
    await adjustArtifactsUsedTx(tx, ctx.repo.orgId, 1);
    return row.id;
  });
}

/**
 * Shared publish tail for blob-backed formats: create the package version, and
 * if the version already exists (conflict) release the just-created blob ref and
 * report the conflict; otherwise enqueue a scan for the stored blob. Used by the
 * cargo/go/nuget adapters, whose only divergence is the 409 / success response.
 */
export async function commitVersionOrReleaseBlob(
  ctx: RegistryRequestContext,
  opts: {
    stored: StoredBlob;
    kind: BlobRefKind;
    scope: string;
    packageId: string;
    version: string;
    metadata: Record<string, unknown>;
    sizeBytes: number;
    scan: { name?: string; version?: string; mediaType?: string };
  },
): Promise<{ versionId: string } | { conflict: true }> {
  const versionId = await createPackageVersion(ctx, {
    packageId: opts.packageId,
    version: opts.version,
    metadata: opts.metadata,
    sizeBytes: opts.sizeBytes,
  });
  if (!versionId) {
    if (opts.stored.refCreated) {
      await releaseBlobRef(ctx, { digest: opts.stored.digest, kind: opts.kind, scope: opts.scope });
    }
    return { conflict: true };
  }
  await ctx.enqueueScan({
    digest: opts.stored.digest,
    name: opts.scan.name,
    version: opts.scan.version,
    mediaType: opts.scan.mediaType,
  });
  return { versionId };
}

export async function setDistTag(packageId: string, tag: string, versionId: string): Promise<void> {
  await db
    .insert(versionTags)
    .values({ packageId, tag, versionId })
    .onConflictDoUpdate({ target: [versionTags.packageId, versionTags.tag], set: { versionId } });
}
