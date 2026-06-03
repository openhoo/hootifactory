import {
  and,
  asc,
  count,
  desc,
  eq,
  isNull,
  like,
  packages,
  packageVersions,
  sql,
  users,
  versionTags,
} from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";

export type PackageVersionReadRow = typeof packageVersions.$inferSelect;

export interface PackageNameRow {
  name: string;
}

export interface PackageSummaryRow {
  id: string;
  name: string;
}

export interface PackageVersionNameRow {
  version: string;
}

export interface DistTagVersionRow {
  tag: string;
  version: string;
}

export interface PackageSearchResult {
  packages: PackageSummaryRow[];
  total: number;
}

export interface VersionMetadataRow {
  version: string;
  metadata: unknown;
  createdAt: Date;
}

export interface VersionPublisherRow {
  id: string;
  login: string;
  name: string | null;
}

export interface PatchPackageVersionRow {
  id: string;
  metadata: unknown;
  deletedAt: Date | null;
}

export interface PatchPackageVersionUpdate<T> {
  update?: {
    metadata: Record<string, unknown>;
    sizeBytes?: number;
  };
  result: T;
}

export async function listRepositoryPackageNames(
  ctx: RegistryRequestContext,
): Promise<PackageNameRow[]> {
  return ctx.db
    .select({ name: packages.name })
    .from(packages)
    .where(eq(packages.repositoryId, ctx.repo.id));
}

export async function listRepositoryPackages(
  ctx: RegistryRequestContext,
): Promise<PackageSummaryRow[]> {
  return ctx.db
    .select({ id: packages.id, name: packages.name })
    .from(packages)
    .where(eq(packages.repositoryId, ctx.repo.id));
}

export async function searchRepositoryPackages(
  ctx: RegistryRequestContext,
  opts: { text: string; from: number; size: number },
): Promise<PackageSearchResult> {
  const where = and(
    eq(packages.repositoryId, ctx.repo.id),
    opts.text ? like(packages.name, `%${opts.text}%`) : sql`true`,
  );
  const totalRows = (await ctx.db.select({ value: count() }).from(packages).where(where)) as Array<{
    value: number;
  }>;
  const rows = (await ctx.db
    .select({ id: packages.id, name: packages.name })
    .from(packages)
    .where(where)
    .limit(opts.size)
    .offset(opts.from)) as PackageSummaryRow[];
  return { packages: rows, total: totalRows[0]?.value ?? 0 };
}

export async function listLivePackageVersions(
  ctx: RegistryRequestContext,
  packageId: string,
  opts: { orderByCreated?: "asc" | "desc" } = {},
): Promise<PackageVersionReadRow[]> {
  const query = ctx.db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
  if (opts.orderByCreated === "asc") return query.orderBy(asc(packageVersions.createdAt));
  if (opts.orderByCreated === "desc")
    return query.orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));
  return query;
}

export async function listPackageVersionNames(
  ctx: RegistryRequestContext,
  packageId: string,
): Promise<PackageVersionNameRow[]> {
  return ctx.db
    .select({ version: packageVersions.version })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));
}

export async function listLiveDistTags(
  ctx: RegistryRequestContext,
  packageId: string,
): Promise<Record<string, string>> {
  const rows = (await ctx.db
    .select({ tag: versionTags.tag, version: packageVersions.version })
    .from(versionTags)
    .innerJoin(packageVersions, eq(versionTags.versionId, packageVersions.id))
    .where(
      and(eq(versionTags.packageId, packageId), isNull(packageVersions.deletedAt)),
    )) as DistTagVersionRow[];
  const tags: Record<string, string> = {};
  for (const row of rows) tags[row.tag] = row.version;
  return tags;
}

export async function deleteDistTag(
  ctx: RegistryRequestContext,
  packageId: string,
  tag: string,
): Promise<void> {
  await ctx.db
    .delete(versionTags)
    .where(and(eq(versionTags.packageId, packageId), eq(versionTags.tag, tag)));
}

export async function updatePackageLatestVersion(
  ctx: RegistryRequestContext,
  packageId: string,
  latestVersion: string | null,
): Promise<void> {
  await ctx.db.update(packages).set({ latestVersion }).where(eq(packages.id, packageId));
}

export async function replaceDistTags(
  ctx: RegistryRequestContext,
  packageId: string,
  desiredTags: Map<string, { version: string; versionId: string }>,
): Promise<void> {
  const currentTags = await listLiveDistTags(ctx, packageId);
  for (const tag of Object.keys(currentTags)) {
    if (desiredTags.has(tag)) continue;
    await deleteDistTag(ctx, packageId, tag);
  }
  for (const [tag, { versionId }] of desiredTags) {
    await ctx.db
      .insert(versionTags)
      .values({ packageId, tag, versionId })
      .onConflictDoUpdate({ target: [versionTags.packageId, versionTags.tag], set: { versionId } });
  }
  await updatePackageLatestVersion(ctx, packageId, desiredTags.get("latest")?.version ?? null);
}

export async function packageVersionExists(
  ctx: RegistryRequestContext,
  packageId: string,
  version: string,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);
  return Boolean(row);
}

export async function listRepositoryVersionMetadata(
  ctx: RegistryRequestContext,
  opts: { packageId?: string; liveOnly?: boolean } = {},
): Promise<VersionMetadataRow[]> {
  const conditions = [
    opts.packageId
      ? eq(packageVersions.packageId, opts.packageId)
      : eq(packages.repositoryId, ctx.repo.id),
  ];
  if (opts.liveOnly ?? true) conditions.push(isNull(packageVersions.deletedAt));
  return ctx.db
    .select({
      version: packageVersions.version,
      metadata: packageVersions.metadata,
      createdAt: packageVersions.createdAt,
    })
    .from(packageVersions)
    .innerJoin(packages, eq(packageVersions.packageId, packages.id))
    .where(and(...conditions));
}

export async function updatePackageVersionMetadata(
  ctx: RegistryRequestContext,
  versionId: string,
  metadata: Record<string, unknown>,
  opts: { sizeBytes?: number } = {},
): Promise<void> {
  await ctx.db
    .update(packageVersions)
    .set({ metadata, ...(opts.sizeBytes === undefined ? {} : { sizeBytes: opts.sizeBytes }) })
    .where(eq(packageVersions.id, versionId));
}

export async function patchPackageVersion<T>(
  ctx: RegistryRequestContext,
  opts: {
    packageId: string;
    version: string;
    patch: (row: PatchPackageVersionRow | null) => PatchPackageVersionUpdate<T>;
  },
): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: packageVersions.id,
        metadata: packageVersions.metadata,
        deletedAt: packageVersions.deletedAt,
      })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, opts.packageId),
          eq(packageVersions.version, opts.version),
        ),
      )
      .for("update")
      .limit(1);
    const patched = opts.patch(row ?? null);
    if (patched.update && row?.id) {
      await tx
        .update(packageVersions)
        .set({
          metadata: patched.update.metadata,
          ...(patched.update.sizeBytes === undefined
            ? {}
            : { sizeBytes: patched.update.sizeBytes }),
        })
        .where(eq(packageVersions.id, row.id));
    }
    return patched.result;
  });
}

export async function listLiveVersionPublishers(
  ctx: RegistryRequestContext,
  packageId: string,
): Promise<VersionPublisherRow[]> {
  return ctx.db
    .select({
      id: users.id,
      login: users.username,
      name: users.displayName,
    })
    .from(packageVersions)
    .innerJoin(users, eq(packageVersions.publishedByUserId, users.id))
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)))
    .orderBy(asc(packageVersions.createdAt));
}
