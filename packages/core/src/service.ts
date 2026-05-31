import { blobRefs, blobs, eq, packageVersions, sql, versionTags } from "@hootifactory/db";
import type { RepoContext } from "./format/adapter";

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
}

/**
 * Store bytes in the CAS and record a repo-scoped reference, bumping ref_count
 * transactionally. A duplicate (kind, repo, scope, digest) is a no-op ref.
 */
export async function storeBlobWithRef(
  ctx: RepoContext,
  opts: { data: Uint8Array; mediaType?: string; kind: BlobRefKind; scope: string },
): Promise<StoredBlob> {
  const put = await ctx.blobs.put(opts.data);
  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(blobs)
      .values({
        digest: put.digest,
        sizeBytes: put.size,
        storageKey: ctx.blobs.blobKey(put.digest),
        mediaType: opts.mediaType ?? null,
        refCount: 0,
        state: "active",
      })
      .onConflictDoNothing();
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
      await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + 1` })
        .where(eq(blobs.digest, put.digest));
    }
  });
  return put;
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
  const [row] = await ctx.db
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
  return row.id;
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
