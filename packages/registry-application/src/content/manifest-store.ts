import {
  and,
  asc,
  blobRefs,
  contentBlobRefs,
  contentManifests,
  contentTags,
  db,
  eq,
  gt,
  inArray,
  isNull,
  packages,
  packageVersions,
  sql,
} from "@hootifactory/db";
import type {
  RegistryRequestContext,
  RegistryTagListOptions,
  RegistryTagListPage,
} from "@hootifactory/registry";
import { adjustArtifactsUsedTx, type Tx } from "../governance/quota";
import { lockDigestTx } from "./blobs";

export type ContentManifestRow = typeof contentManifests.$inferSelect;

export interface ContentManifestRawRow {
  digest: string;
  raw: string;
}

interface ContentDigestRow {
  digest: string;
}

interface ContentTagRow {
  tag: string;
}

interface ContentVersionMetadataRow {
  metadata: { digest?: unknown };
}

export interface UpsertContentManifestInput {
  digest: string;
  mediaType: string;
  artifactType: string | null;
  subjectDigest: string | null;
  raw: string;
  sizeBytes: number;
  configDigest: string | null;
}

function packageVersionDigestEquals(digest: string) {
  return sql`jsonb_extract_path_text((${packageVersions.metadata} #>> '{}')::jsonb, ${"digest"}) = ${digest}`;
}

/**
 * Advisory-lock key scoping a manifest to its repository+digest. The manifest
 * write (commitContentManifest) and the unassociated-delete take this same lock
 * so they serialize against each other.
 */
function manifestLockKey(repositoryId: string, digest: string): string {
  // Postgres text (the bind type for the advisory-lock hash) cannot contain null
  // bytes, so use a printable delimiter. repositoryId is a UUID, so ':' is
  // unambiguous.
  return `content_manifest:${repositoryId}:${digest}`;
}

export async function listExistingContentBlobRefDigests(
  ctx: RegistryRequestContext,
  opts: { scope: string; digests: string[] },
): Promise<string[]> {
  if (opts.digests.length === 0) return [];
  const rows = (await db
    .select({ digest: blobRefs.digest })
    .from(blobRefs)
    .where(
      and(
        eq(blobRefs.repositoryId, ctx.repo.id),
        eq(blobRefs.scope, opts.scope),
        inArray(blobRefs.digest, opts.digests),
      ),
    )) as ContentDigestRow[];
  return rows.map((row) => row.digest);
}

export async function listExistingContentManifestDigests(
  ctx: RegistryRequestContext,
  opts: { packageId: string; digests: string[] },
): Promise<string[]> {
  if (opts.digests.length === 0) return [];
  const taggedRows = (await db
    .select({ digest: contentManifests.digest })
    .from(contentTags)
    .innerJoin(contentManifests, eq(contentTags.manifestId, contentManifests.id))
    .where(
      and(
        eq(contentTags.packageId, opts.packageId),
        eq(contentManifests.repositoryId, ctx.repo.id),
        inArray(contentManifests.digest, opts.digests),
      ),
    )) as ContentDigestRow[];
  const versionRows = (await db
    .select({ digest: packageVersions.version })
    .from(packageVersions)
    .innerJoin(
      contentManifests,
      and(
        eq(contentManifests.repositoryId, ctx.repo.id),
        eq(contentManifests.digest, packageVersions.version),
      ),
    )
    .where(
      and(
        eq(packageVersions.packageId, opts.packageId),
        isNull(packageVersions.deletedAt),
        inArray(packageVersions.version, opts.digests),
      ),
    )) as ContentDigestRow[];
  return [...new Set([...taggedRows, ...versionRows].map((row) => row.digest))];
}

export async function replaceContentManifestBlobRefs(
  ctx: RegistryRequestContext,
  opts: { packageId: string; manifestId: string; digests: string[] },
): Promise<void> {
  const digests = [...new Set(opts.digests)];
  await db.transaction(async (tx) => {
    await tx
      .delete(contentBlobRefs)
      .where(
        and(
          eq(contentBlobRefs.repositoryId, ctx.repo.id),
          eq(contentBlobRefs.packageId, opts.packageId),
          eq(contentBlobRefs.manifestId, opts.manifestId),
        ),
      );
    if (digests.length === 0) return;
    await tx
      .insert(contentBlobRefs)
      .values(
        digests.map((digest) => ({
          repositoryId: ctx.repo.id,
          packageId: opts.packageId,
          manifestId: opts.manifestId,
          blobDigest: digest,
        })),
      )
      .onConflictDoNothing();
  });
}

export async function listContentManifestDigestsReferencingBlob(
  ctx: RegistryRequestContext,
  opts: { packageId: string; digest: string },
): Promise<string[]> {
  const taggedRows = (await db
    .select({ digest: contentManifests.digest })
    .from(contentBlobRefs)
    .innerJoin(contentManifests, eq(contentBlobRefs.manifestId, contentManifests.id))
    .innerJoin(
      contentTags,
      and(
        eq(contentTags.packageId, contentBlobRefs.packageId),
        eq(contentTags.manifestId, contentBlobRefs.manifestId),
      ),
    )
    .where(
      and(
        eq(contentBlobRefs.repositoryId, ctx.repo.id),
        eq(contentBlobRefs.packageId, opts.packageId),
        eq(contentBlobRefs.blobDigest, opts.digest),
      ),
    )) as ContentDigestRow[];
  const versionRows = (await db
    .select({ digest: contentManifests.digest })
    .from(contentBlobRefs)
    .innerJoin(contentManifests, eq(contentBlobRefs.manifestId, contentManifests.id))
    .innerJoin(
      packageVersions,
      and(
        eq(packageVersions.packageId, contentBlobRefs.packageId),
        eq(
          contentManifests.digest,
          sql`jsonb_extract_path_text((${packageVersions.metadata} #>> '{}')::jsonb, ${"digest"})`,
        ),
        isNull(packageVersions.deletedAt),
      ),
    )
    .where(
      and(
        eq(contentBlobRefs.repositoryId, ctx.repo.id),
        eq(contentBlobRefs.packageId, opts.packageId),
        eq(contentBlobRefs.blobDigest, opts.digest),
      ),
    )) as ContentDigestRow[];
  return [...new Set([...taggedRows, ...versionRows].map((row) => row.digest))];
}

export async function contentBlobRefExists(
  ctx: RegistryRequestContext,
  opts: { scope: string; digest: string },
): Promise<boolean> {
  const [ref] = await db
    .select({ id: blobRefs.id })
    .from(blobRefs)
    .where(
      and(
        eq(blobRefs.repositoryId, ctx.repo.id),
        eq(blobRefs.scope, opts.scope),
        eq(blobRefs.digest, opts.digest),
      ),
    )
    .limit(1);
  return Boolean(ref);
}

/**
 * Atomically upsert a manifest and (re)point its tags under a single advisory
 * lock keyed on (repo, digest). Holding the manifest write and its tag writes in
 * one locked transaction serializes them against deleteContentManifestIfUnassociated,
 * so a concurrent delete cannot cascade-remove a tag this push just created
 * (content_tags FKs onto content_manifests with ON DELETE CASCADE).
 */
export async function commitContentManifest(
  ctx: RegistryRequestContext,
  opts: { manifest: UpsertContentManifestInput; packageId: string; tags: string[] },
): Promise<{ id: string; repositoryId: string; digest: string }> {
  const input = opts.manifest;
  return db.transaction(async (tx) => {
    await lockDigestTx(tx, manifestLockKey(ctx.repo.id, input.digest));
    const [manifest] = await tx
      .insert(contentManifests)
      .values({
        repositoryId: ctx.repo.id,
        digest: input.digest,
        mediaType: input.mediaType,
        artifactType: input.artifactType,
        subjectDigest: input.subjectDigest,
        raw: input.raw,
        sizeBytes: input.sizeBytes,
        configDigest: input.configDigest,
      })
      .onConflictDoUpdate({
        target: [contentManifests.repositoryId, contentManifests.digest],
        set: {
          raw: input.raw,
          mediaType: input.mediaType,
          artifactType: input.artifactType,
          sizeBytes: input.sizeBytes,
          subjectDigest: input.subjectDigest,
          configDigest: input.configDigest,
        },
      })
      .returning({
        id: contentManifests.id,
        repositoryId: contentManifests.repositoryId,
        digest: contentManifests.digest,
      });
    if (!manifest) throw new Error("failed to upsert content manifest");
    for (const tag of opts.tags) {
      await tx
        .insert(contentTags)
        .values({
          repositoryId: ctx.repo.id,
          packageId: opts.packageId,
          tag,
          manifestId: manifest.id,
        })
        .onConflictDoUpdate({
          target: [contentTags.packageId, contentTags.tag],
          set: { manifestId: manifest.id },
        });
    }
    return manifest;
  });
}

export async function resolveContentManifest(
  ctx: RegistryRequestContext,
  opts: { packageId: string; reference: string },
): Promise<ContentManifestRow | null> {
  if (opts.reference.startsWith("sha256:")) {
    const [tagged] = await db
      .select({ manifest: contentManifests })
      .from(contentTags)
      .innerJoin(contentManifests, eq(contentTags.manifestId, contentManifests.id))
      .where(
        and(eq(contentTags.packageId, opts.packageId), eq(contentManifests.digest, opts.reference)),
      )
      .limit(1);
    if (tagged) return tagged.manifest;

    const [digestVersion] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, opts.packageId),
          eq(packageVersions.version, opts.reference),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    if (!digestVersion) return null;

    const [manifest] = await db
      .select()
      .from(contentManifests)
      .where(
        and(
          eq(contentManifests.repositoryId, ctx.repo.id),
          eq(contentManifests.digest, opts.reference),
        ),
      )
      .limit(1);
    return manifest ?? null;
  }

  const [tagged] = await db
    .select({ manifest: contentManifests })
    .from(contentTags)
    .innerJoin(contentManifests, eq(contentTags.manifestId, contentManifests.id))
    .where(and(eq(contentTags.packageId, opts.packageId), eq(contentTags.tag, opts.reference)))
    .limit(1);
  return tagged?.manifest ?? null;
}

export async function deleteContentTagsForManifest(opts: {
  packageId: string;
  manifestId: string;
}): Promise<void> {
  await db
    .delete(contentTags)
    .where(
      and(eq(contentTags.packageId, opts.packageId), eq(contentTags.manifestId, opts.manifestId)),
    );
}

export async function markContentPackageVersionsDeletedByDigest(opts: {
  orgId: string;
  packageId: string;
  digest: string;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .update(packageVersions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(packageVersions.packageId, opts.packageId),
          isNull(packageVersions.deletedAt),
          packageVersionDigestEquals(opts.digest),
        ),
      )
      .returning({ id: packageVersions.id });
    if (deleted.length > 0) {
      await adjustArtifactsUsedTx(tx, opts.orgId, -deleted.length);
    }
    return deleted.length;
  });
}

export async function deleteContentManifestIfUnassociated(
  ctx: RegistryRequestContext,
  opts: { manifestId: string; digest: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serialize against commitContentManifest on the same (repo, digest) key and
    // re-check associations *inside* the lock, so we never cascade-delete a tag a
    // concurrent push created after the check.
    await lockDigestTx(tx, manifestLockKey(ctx.repo.id, opts.digest));
    if (await contentManifestHasLiveAssociations(tx, ctx, opts)) return false;
    const deleted = await tx
      .delete(contentManifests)
      .where(
        and(
          eq(contentManifests.repositoryId, ctx.repo.id),
          eq(contentManifests.digest, opts.digest),
        ),
      )
      .returning({ id: contentManifests.id });
    return deleted.length > 0;
  });
}

async function contentManifestHasLiveAssociations(
  tx: Tx,
  ctx: RegistryRequestContext,
  opts: { manifestId: string; digest: string },
): Promise<boolean> {
  const [tag] = await tx
    .select({ id: contentTags.id })
    .from(contentTags)
    .where(eq(contentTags.manifestId, opts.manifestId))
    .limit(1);
  if (tag) return true;

  const [version] = await tx
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .innerJoin(packages, eq(packageVersions.packageId, packages.id))
    .where(
      and(
        eq(packages.repositoryId, ctx.repo.id),
        isNull(packageVersions.deletedAt),
        packageVersionDigestEquals(opts.digest),
      ),
    )
    .limit(1);
  return Boolean(version);
}

export async function deleteContentTag(opts: { packageId: string; tag: string }): Promise<boolean> {
  const deleted = await db
    .delete(contentTags)
    .where(and(eq(contentTags.packageId, opts.packageId), eq(contentTags.tag, opts.tag)))
    .returning({ id: contentTags.id });
  return deleted.length > 0;
}

export async function listLiveContentManifestsForPackage(
  ctx: RegistryRequestContext,
  packageId: string,
): Promise<ContentManifestRawRow[]> {
  const tagRows = (await db
    .select({ digest: contentManifests.digest })
    .from(contentTags)
    .innerJoin(contentManifests, eq(contentTags.manifestId, contentManifests.id))
    .where(eq(contentTags.packageId, packageId))) as ContentDigestRow[];
  const versionRows = (await db
    .select({ metadata: packageVersions.metadata })
    .from(packageVersions)
    .where(
      and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)),
    )) as ContentVersionMetadataRow[];

  const digests = new Set<string>(tagRows.map((row) => row.digest));
  for (const row of versionRows) {
    const digest = row.metadata.digest;
    if (typeof digest === "string") digests.add(digest);
  }
  if (digests.size === 0) return [];

  return db
    .select({ digest: contentManifests.digest, raw: contentManifests.raw })
    .from(contentManifests)
    .where(
      and(
        eq(contentManifests.repositoryId, ctx.repo.id),
        inArray(contentManifests.digest, [...digests]),
      ),
    );
}

export async function listContentTags(
  packageId: string,
  opts: RegistryTagListOptions = {},
): Promise<RegistryTagListPage> {
  const where =
    opts.last === undefined
      ? eq(contentTags.packageId, packageId)
      : and(eq(contentTags.packageId, packageId), gt(contentTags.tag, opts.last));
  const query = db
    .select({ tag: contentTags.tag })
    .from(contentTags)
    .where(where)
    .orderBy(asc(contentTags.tag));
  const rows = (await (opts.pageSize === undefined
    ? query
    : query.limit(opts.pageSize + 1))) as ContentTagRow[];
  const truncated = opts.pageSize !== undefined && rows.length > opts.pageSize;
  const pageRows = opts.pageSize === undefined ? rows : rows.slice(0, opts.pageSize);
  return {
    tags: pageRows.map((row) => row.tag),
    truncated,
  };
}

export async function listContentSubjectManifests(
  ctx: RegistryRequestContext,
  subjectDigest: string,
): Promise<ContentManifestRow[]> {
  return db
    .select()
    .from(contentManifests)
    .where(
      and(
        eq(contentManifests.repositoryId, ctx.repo.id),
        eq(contentManifests.subjectDigest, subjectDigest),
      ),
    );
}
