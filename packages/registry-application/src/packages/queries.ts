import { safeJsonParse } from "@hootifactory/core";
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
import { dateField, fieldValue, rowsFromExecute, stringField } from "../runtime/raw-rows";

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

export interface PackageVersionFingerprintRow {
  version: string;
  updatedAt: Date;
}

export interface PackageSearchVersionRow {
  packageId: string;
  version: string;
  metadata: unknown;
  createdAt: Date;
}

export interface PackageSearchResult {
  packages: PackageSummaryRow[];
  total: number;
}

function metadataField(row: unknown): unknown {
  const value = fieldValue(row, "metadata");
  if (typeof value !== "string") return value ?? null;
  const decoded = safeJsonParse(value);
  return decoded.success ? decoded.data : null;
}

function uuidValueRows(values: string[]) {
  return sql.join(
    values.map((value) => sql`(${value}::uuid)`),
    sql`, `,
  );
}

function packageVersionValueRows(entries: Array<[packageId: string, version: string]>) {
  return sql.join(
    entries.map(([packageId, version]) => sql`(${packageId}::uuid, ${version}::text)`),
    sql`, `,
  );
}

function packageSearchVersionRow(row: unknown): PackageSearchVersionRow | null {
  const packageId = stringField(row, "packageId");
  const version = stringField(row, "version");
  const createdAt = dateField(row, "createdAt");
  if (!packageId || !version || !createdAt) return null;
  return {
    packageId,
    version,
    createdAt,
    metadata: metadataField(row),
  };
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

function numericTotal(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
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
      ? sql`${packages.name} ilike ${packageSearchLikePattern(opts.text)} escape '\\'`
      : sql`true`,
  );
  const rows = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      repositoryId: packages.repositoryId,
      name: packages.name,
      total: sql<number>`count(*) over()`,
    })
    .from(packages)
    .where(where)
    .orderBy(packages.name, packages.id)
    .limit(opts.size)
    .offset(opts.from);
  if (rows.length > 0) {
    return {
      packages: rows.map(({ total: _total, ...row }) => row),
      total: numericTotal(rows[0]?.total),
    };
  }
  const totalRows = await db.select({ value: count() }).from(packages).where(where);
  return { packages: [], total: totalRows[0]?.value ?? 0 };
}

export function listLivePackageVersions(
  packageId: string,
  opts: { orderByCreated?: "asc" | "desc" } = {},
): Promise<PackageVersionReadRow[]> {
  const query = db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
  // Always order by a UNIQUE total key (createdAt + the id tiebreak). createdAt
  // is not unique — versions published in the same millisecond tie — so ordering
  // by it alone (or not at all) lets Postgres return tied rows in plan/heap order
  // that can differ between two otherwise-identical requests. Metadata builders
  // (npm packument, cargo sparse index, pypi simple) serialize this row order
  // verbatim, so a non-total order makes the response bytes non-deterministic and
  // flakes the gzip-vs-identity byte-equality check. Index-backed by
  // package_versions_live_created_idx (packageId, createdAt, id).
  if (opts.orderByCreated === "desc")
    return query.orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));
  return query.orderBy(asc(packageVersions.createdAt), asc(packageVersions.id));
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
        : await query.orderBy(
            asc(packageVersions.packageId),
            asc(packageVersions.createdAt),
            asc(packageVersions.id),
          );
  for (const row of rows) {
    byPackageId.get(row.packageId)?.push(row);
  }
  return byPackageId;
}

export async function listSearchPackageVersionsForPackages(
  packageIds: string[],
  preferredVersionsByPackageId: Map<string, string>,
): Promise<Map<string, PackageSearchVersionRow>> {
  const ids = [...new Set(packageIds)];
  const byPackageId = new Map<string, PackageSearchVersionRow>();
  if (ids.length === 0) return byPackageId;

  const preferredEntries = ids.flatMap((id) => {
    const version = preferredVersionsByPackageId.get(id);
    return version ? ([[id, version]] as Array<[string, string]>) : [];
  });
  if (preferredEntries.length > 0) {
    const preferredRows = rowsFromExecute(
      await db.execute(sql`
        with preferred(package_id, version) as (
          values ${packageVersionValueRows(preferredEntries)}
        )
        select
          pv.package_id as "packageId",
          pv.version,
          pv.metadata,
          pv.created_at as "createdAt"
        from package_versions pv
        inner join preferred p on p.package_id = pv.package_id and p.version = pv.version
        where pv.deleted_at is null
      `),
    );
    for (const rawRow of preferredRows) {
      const row = packageSearchVersionRow(rawRow);
      if (row) byPackageId.set(row.packageId, row);
    }
  }

  const missingIds = ids.filter((id) => !byPackageId.has(id));
  if (missingIds.length === 0) return byPackageId;

  const fallbackRows = rowsFromExecute(
    await db.execute(sql`
      with requested(package_id) as (
        values ${uuidValueRows(missingIds)}
      )
      select distinct on (pv.package_id)
        pv.package_id as "packageId",
        pv.version,
        pv.metadata,
        pv.created_at as "createdAt"
      from package_versions pv
      inner join requested r on r.package_id = pv.package_id
      where pv.deleted_at is null
      order by pv.package_id, pv.created_at desc, pv.id desc
    `),
  );
  for (const rawRow of fallbackRows) {
    const row = packageSearchVersionRow(rawRow);
    if (row) byPackageId.set(row.packageId, row);
  }
  return byPackageId;
}

export async function listPackageVersionNames(packageId: string): Promise<PackageVersionNameRow[]> {
  return db
    .select({ version: packageVersions.version })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));
}

export function listLivePackageVersionNames(
  packageId: string,
  opts: { orderByCreated?: "asc" | "desc" } = {},
): Promise<PackageVersionNameRow[]> {
  const query = db
    .select({ version: packageVersions.version })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
  if (opts.orderByCreated === "desc")
    return query.orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));
  // Default to the same unique total order as the explicit "asc" request so the
  // version-name list is deterministic across requests (see listLivePackageVersions).
  return query.orderBy(asc(packageVersions.createdAt), asc(packageVersions.id));
}

export async function listLivePackageVersionFingerprints(
  packageId: string,
): Promise<PackageVersionFingerprintRow[]> {
  return db
    .select({ version: packageVersions.version, updatedAt: packageVersions.updatedAt })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)))
    .orderBy(asc(packageVersions.version), asc(packageVersions.id));
}

export async function listLiveDistTags(packageId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ tag: versionTags.tag, version: packageVersions.version })
    .from(versionTags)
    .innerJoin(packageVersions, eq(versionTags.versionId, packageVersions.id))
    .where(and(eq(versionTags.packageId, packageId), isNull(packageVersions.deletedAt)));
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

  const rows = await db
    .select({
      packageId: versionTags.packageId,
      tag: versionTags.tag,
      version: packageVersions.version,
    })
    .from(versionTags)
    .innerJoin(packageVersions, eq(versionTags.versionId, packageVersions.id))
    .where(and(inArray(versionTags.packageId, ids), isNull(packageVersions.deletedAt)));
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
  // The dist-tag set (versionTags) and the denormalized packages.latestVersion are
  // two reads for the same logical pointer, so the prune + upsert + latestVersion
  // write must land atomically. Without a transaction a concurrent packument GET
  // can observe tags that are pruned but not yet re-inserted, and two concurrent
  // writers can leave latestVersion sourced from one writer while the `latest` tag
  // row comes from the other. The FOR UPDATE lock on the packages row serializes
  // concurrent replaceDistTags callers per package so last-writer-wins stays
  // coherent; it does not order against writers that skip this lock (e.g.
  // setDistTag / deleteDistTag), which only touch a single tag row.
  const tags = [...desiredTags.keys()];
  await db.transaction(async (tx) => {
    await tx
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.id, packageId))
      .for("update")
      .limit(1);
    await tx
      .delete(versionTags)
      .where(
        and(
          eq(versionTags.packageId, packageId),
          tags.length > 0 ? notInArray(versionTags.tag, tags) : sql`true`,
        ),
      );
    if (desiredTags.size > 0) {
      await tx
        .insert(versionTags)
        .values([...desiredTags].map(([tag, { versionId }]) => ({ packageId, tag, versionId })))
        .onConflictDoUpdate({
          target: [versionTags.packageId, versionTags.tag],
          set: { versionId: sql`excluded.version_id` },
        });
    }
    await tx
      .update(packages)
      .set({ latestVersion: desiredTags.get("latest")?.version ?? null })
      .where(eq(packages.id, packageId));
  });
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
