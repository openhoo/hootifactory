import { and, blobRefs, blobs, eq, packageVersions, versionTags } from "@hootifactory/db";
import type { RepoContext } from "./format/adapter";
import {
  type BlobRefKind,
  ensureActiveBlobTx,
  incrementBlobRefCountTx,
  insertBlobRefTx,
  type StoredBlob,
} from "./service-blobs";
import {
  adjustArtifactsUsedTx,
  adjustStorageUsedTx,
  assertArtifactQuotaRowAllows,
  assertStorageQuotaRowAllows,
  lockOrgQuotaTx,
  orgAlreadyReferencesDigestTx,
} from "./service-quota";

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

    await ensureActiveBlobTx(tx, ctx, put, opts.blob.mediaType);
    refCreated = await insertBlobRefTx(tx, ctx, {
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
