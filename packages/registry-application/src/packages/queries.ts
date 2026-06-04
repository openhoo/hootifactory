import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
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
  orgId: string;
  repositoryId: string;
  name: string;
}

export interface PackageVersionNameRow {
  version: string;
}

export interface DistTagVersionRow {
  tag: string;
  version: string;
}

export interface DistTagVersionPackageRow extends DistTagVersionRow {
  packageId: string;
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

export function packageSearchLikePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function listRepositoryPackageNames(
  ctx: RegistryRequestContext,
): Promise<PackageNameRow[]> {
  return db
    .select({ name: packages.name })
    .from(packages)
    .where(eq(packages.repositoryId, ctx.repo.id))
    .orderBy(packages.name);
}

export async function listRepositoryPackages(
  ctx: RegistryRequestContext,
): Promise<PackageSummaryRow[]> {
  return db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      repositoryId: packages.repositoryId,
      name: packages.name,
    })
    .from(packages)
    .where(eq(packages.repositoryId, ctx.repo.id))
    .orderBy(packages.name);
}

export async function searchRepositoryPackages(
  ctx: RegistryRequestContext,
  opts: { text: string; from: number; size: number },
): Promise<PackageSearchResult> {
  const where = and(
    eq(packages.repositoryId, ctx.repo.id),
    opts.text
      ? sql`${packages.name} like ${packageSearchLikePattern(opts.text)} escape '\\'`
      : sql`true`,
  );
  const totalRows = (await db.select({ value: count() }).from(packages).where(where)) as Array<{
    value: number;
  }>;
  const rows = (await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      repositoryId: packages.repositoryId,
      name: packages.name,
    })
    .from(packages)
    .where(where)
    .limit(opts.size)
    .offset(opts.from)) as PackageSummaryRow[];
  return { packages: rows, total: totalRows[0]?.value ?? 0 };
}

export async function listLivePackageVersions(
  packageId: string,
  opts: { orderByCreated?: "asc" | "desc" } = {},
): Promise<PackageVersionReadRow[]> {
  const query = db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
  if (opts.orderByCreated === "asc") return query.orderBy(asc(packageVersions.createdAt));
  if (opts.orderByCreated === "desc")
    return query.orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));
  return query;
}

export async function listLivePackageVersionsForPackages(
  packageIds: string[],
  opts: { orderByCreated?: "asc" | "desc" } = {},
): Promise<Map<string, PackageVersionReadRow[]>> {
  const ids = [...new Set(packageIds)];
  const byPackageId = new Map(ids.map((id) => [id, [] as PackageVersionReadRow[]]));
  if (ids.length === 0) return byPackageId;

  const query = db
    .select()
    .from(packageVersions)
    .where(and(inArray(packageVersions.packageId, ids), isNull(packageVersions.deletedAt)));
  const rows =
    opts.orderByCreated === "asc"
      ? await query.orderBy(
          asc(packageVersions.packageId),
          asc(packageVersions.createdAt),
          asc(packageVersions.id),
        )
      : opts.orderByCreated === "desc"
        ? await query.orderBy(
            asc(packageVersions.packageId),
            desc(packageVersions.createdAt),
            desc(packageVersions.id),
          )
        : await query;
  for (const row of rows as PackageVersionReadRow[]) {
    byPackageId.get(row.packageId)?.push(row);
  }
  return byPackageId;
}

export async function listPackageVersionNames(packageId: string): Promise<PackageVersionNameRow[]> {
  return db
    .select({ version: packageVersions.version })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));
}

export async function listLiveDistTags(packageId: string): Promise<Record<string, string>> {
  const rows = (await db
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

export async function listLiveDistTagsForPackages(
  packageIds: string[],
): Promise<Map<string, Record<string, string>>> {
  const ids = [...new Set(packageIds)];
  const byPackageId = new Map(ids.map((id) => [id, {} as Record<string, string>]));
  if (ids.length === 0) return byPackageId;

  const rows = (await db
    .select({
      packageId: versionTags.packageId,
      tag: versionTags.tag,
      version: packageVersions.version,
    })
    .from(versionTags)
    .innerJoin(packageVersions, eq(versionTags.versionId, packageVersions.id))
    .where(
      and(inArray(versionTags.packageId, ids), isNull(packageVersions.deletedAt)),
    )) as DistTagVersionPackageRow[];
  for (const row of rows) {
    byPackageId.get(row.packageId)![row.tag] = row.version;
  }
  return byPackageId;
}

export async function deleteDistTag(packageId: string, tag: string): Promise<void> {
  await db
    .delete(versionTags)
    .where(and(eq(versionTags.packageId, packageId), eq(versionTags.tag, tag)));
}

export async function updatePackageLatestVersion(
  packageId: string,
  latestVersion: string | null,
): Promise<void> {
  await db.update(packages).set({ latestVersion }).where(eq(packages.id, packageId));
}

export async function replaceDistTags(
  packageId: string,
  desiredTags: Map<string, { version: string; versionId: string }>,
): Promise<void> {
  const tags = [...desiredTags.keys()];
  await db
    .delete(versionTags)
    .where(
      and(
        eq(versionTags.packageId, packageId),
        tags.length > 0 ? notInArray(versionTags.tag, tags) : sql`true`,
      ),
    );
  if (desiredTags.size > 0) {
    await db
      .insert(versionTags)
      .values([...desiredTags].map(([tag, { versionId }]) => ({ packageId, tag, versionId })))
      .onConflictDoUpdate({
        target: [versionTags.packageId, versionTags.tag],
        set: { versionId: sql`excluded.version_id` },
      });
  }
  await updatePackageLatestVersion(packageId, desiredTags.get("latest")?.version ?? null);
}

export async function packageVersionExists(packageId: string, version: string): Promise<boolean> {
  const [row] = await db
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
  return db
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
  versionId: string,
  metadata: Record<string, unknown>,
  opts: { sizeBytes?: number } = {},
): Promise<void> {
  await db
    .update(packageVersions)
    .set({ metadata, ...(opts.sizeBytes === undefined ? {} : { sizeBytes: opts.sizeBytes }) })
    .where(eq(packageVersions.id, versionId));
}

export async function patchPackageVersion<T>(opts: {
  packageId: string;
  version: string;
  patch: (row: PatchPackageVersionRow | null) => PatchPackageVersionUpdate<T>;
}): Promise<T> {
  return db.transaction(async (tx) => {
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

export async function listLiveVersionPublishers(packageId: string): Promise<VersionPublisherRow[]> {
  return db
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
