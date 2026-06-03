import {
  and,
  blobRefs,
  db,
  eq,
  inArray,
  isNull,
  ociManifests,
  ociTags,
  packages,
  packageVersions,
  sql,
} from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";

export type OciManifestRow = typeof ociManifests.$inferSelect;

export interface OciManifestRawRow {
  digest: string;
  raw: string;
}

interface OciDigestRow {
  digest: string;
}

interface OciTagRow {
  tag: string;
}

interface OciVersionMetadataRow {
  metadata: { digest?: unknown };
}

export interface UpsertOciManifestInput {
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

export async function listExistingOciBlobRefDigests(
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
    )) as OciDigestRow[];
  return rows.map((row) => row.digest);
}

export async function ociBlobRefExists(
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

export async function upsertOciManifest(
  ctx: RegistryRequestContext,
  input: UpsertOciManifestInput,
): Promise<{ id: string }> {
  const [manifest] = await db
    .insert(ociManifests)
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
      target: [ociManifests.repositoryId, ociManifests.digest],
      set: {
        raw: input.raw,
        mediaType: input.mediaType,
        artifactType: input.artifactType,
        sizeBytes: input.sizeBytes,
        subjectDigest: input.subjectDigest,
        configDigest: input.configDigest,
      },
    })
    .returning({ id: ociManifests.id });
  if (!manifest) throw new Error("failed to upsert OCI manifest");
  return manifest;
}

export async function upsertOciTag(
  ctx: RegistryRequestContext,
  opts: { packageId: string; tag: string; manifestId: string },
): Promise<void> {
  await db
    .insert(ociTags)
    .values({
      repositoryId: ctx.repo.id,
      packageId: opts.packageId,
      tag: opts.tag,
      manifestId: opts.manifestId,
    })
    .onConflictDoUpdate({
      target: [ociTags.packageId, ociTags.tag],
      set: { manifestId: opts.manifestId },
    });
}

export async function resolveOciManifest(
  ctx: RegistryRequestContext,
  opts: { packageId: string; reference: string },
): Promise<OciManifestRow | null> {
  if (opts.reference.startsWith("sha256:")) {
    const [tagged] = await db
      .select({ manifest: ociManifests })
      .from(ociTags)
      .innerJoin(ociManifests, eq(ociTags.manifestId, ociManifests.id))
      .where(and(eq(ociTags.packageId, opts.packageId), eq(ociManifests.digest, opts.reference)))
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
      .from(ociManifests)
      .where(
        and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, opts.reference)),
      )
      .limit(1);
    return manifest ?? null;
  }

  const [tagged] = await db
    .select({ manifest: ociManifests })
    .from(ociTags)
    .innerJoin(ociManifests, eq(ociTags.manifestId, ociManifests.id))
    .where(and(eq(ociTags.packageId, opts.packageId), eq(ociTags.tag, opts.reference)))
    .limit(1);
  return tagged?.manifest ?? null;
}

export async function deleteOciTagsForManifest(opts: {
  packageId: string;
  manifestId: string;
}): Promise<void> {
  await db
    .delete(ociTags)
    .where(and(eq(ociTags.packageId, opts.packageId), eq(ociTags.manifestId, opts.manifestId)));
}

export async function markOciPackageVersionsDeletedByDigest(opts: {
  packageId: string;
  digest: string;
}): Promise<void> {
  await db
    .update(packageVersions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(packageVersions.packageId, opts.packageId),
        isNull(packageVersions.deletedAt),
        packageVersionDigestEquals(opts.digest),
      ),
    );
}

export async function deleteOciManifestIfUnassociated(
  ctx: RegistryRequestContext,
  opts: { manifestId: string; digest: string },
): Promise<boolean> {
  if (await ociManifestHasLiveAssociations(ctx, opts)) return false;
  const deleted = await db
    .delete(ociManifests)
    .where(and(eq(ociManifests.repositoryId, ctx.repo.id), eq(ociManifests.digest, opts.digest)))
    .returning({ id: ociManifests.id });
  return deleted.length > 0;
}

async function ociManifestHasLiveAssociations(
  ctx: RegistryRequestContext,
  opts: { manifestId: string; digest: string },
): Promise<boolean> {
  const [tag] = await db
    .select({ id: ociTags.id })
    .from(ociTags)
    .where(eq(ociTags.manifestId, opts.manifestId))
    .limit(1);
  if (tag) return true;

  const [version] = await db
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

export async function deleteOciTag(opts: { packageId: string; tag: string }): Promise<boolean> {
  const deleted = await db
    .delete(ociTags)
    .where(and(eq(ociTags.packageId, opts.packageId), eq(ociTags.tag, opts.tag)))
    .returning({ id: ociTags.id });
  return deleted.length > 0;
}

export async function listLiveOciManifestsForPackage(
  ctx: RegistryRequestContext,
  packageId: string,
): Promise<OciManifestRawRow[]> {
  const tagRows = (await db
    .select({ digest: ociManifests.digest })
    .from(ociTags)
    .innerJoin(ociManifests, eq(ociTags.manifestId, ociManifests.id))
    .where(eq(ociTags.packageId, packageId))) as OciDigestRow[];
  const versionRows = (await db
    .select({ metadata: packageVersions.metadata })
    .from(packageVersions)
    .where(
      and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)),
    )) as OciVersionMetadataRow[];

  const digests = new Set<string>(tagRows.map((row) => row.digest));
  for (const row of versionRows) {
    const digest = row.metadata.digest;
    if (typeof digest === "string") digests.add(digest);
  }
  if (digests.size === 0) return [];

  return db
    .select({ digest: ociManifests.digest, raw: ociManifests.raw })
    .from(ociManifests)
    .where(
      and(eq(ociManifests.repositoryId, ctx.repo.id), inArray(ociManifests.digest, [...digests])),
    );
}

export async function listOciTags(packageId: string): Promise<string[]> {
  const rows = (await db
    .select({ tag: ociTags.tag })
    .from(ociTags)
    .where(eq(ociTags.packageId, packageId))) as OciTagRow[];
  return rows.map((row) => row.tag);
}

export async function listOciSubjectManifests(
  ctx: RegistryRequestContext,
  subjectDigest: string,
): Promise<OciManifestRow[]> {
  return db
    .select()
    .from(ociManifests)
    .where(
      and(
        eq(ociManifests.repositoryId, ctx.repo.id),
        eq(ociManifests.subjectDigest, subjectDigest),
      ),
    );
}
