import { and, db, eq, isNull, packages, packageVersions } from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";

export type PackageRow = typeof packages.$inferSelect;

/** Idempotently get-or-create a package within a repo. */
export async function findOrCreatePackage(opts: {
  orgId: string;
  repositoryId: string;
  name: string;
  namespace?: string | null;
}): Promise<PackageRow> {
  const [row] = await db
    .insert(packages)
    .values({
      orgId: opts.orgId,
      repositoryId: opts.repositoryId,
      name: opts.name,
      namespace: opts.namespace ?? null,
    })
    .onConflictDoUpdate({
      target: [packages.repositoryId, packages.name],
      set: { updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("failed to upsert package");
  return row;
}

/** Find a package by exact name within the request's repository (no normalization). */
export async function findPackageByName(
  ctx: RegistryRequestContext,
  name: string,
): Promise<PackageRow | null> {
  const [row] = await db
    .select()
    .from(packages)
    .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, name)))
    .limit(1);
  return row ?? null;
}

export type PackageVersionRow = typeof packageVersions.$inferSelect;

export async function findVersion(
  packageId: string,
  version: string,
): Promise<PackageVersionRow | null> {
  const [row] = await db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);
  return row ?? null;
}

/** Find a single live (not soft-deleted) version by (packageId, version). */
export async function findLiveVersion(
  packageId: string,
  version: string,
): Promise<PackageVersionRow | null> {
  const [row] = await db
    .select()
    .from(packageVersions)
    .where(
      and(
        eq(packageVersions.packageId, packageId),
        eq(packageVersions.version, version),
        isNull(packageVersions.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
