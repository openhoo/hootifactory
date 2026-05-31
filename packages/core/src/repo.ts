import { and, db, eq, packages, packageVersions, repositories } from "@hootifactory/db";
import type { PackageFormat, Visibility } from "@hootifactory/types";
import type { ResolvedRepo } from "./format/adapter";

const V2_FORMATS = new Set<PackageFormat>(["docker", "oci", "helm"]);

/** First URL segment for a format: "v2" for OCI-based, else the format name. */
export function mountSegment(format: PackageFormat): string {
  return V2_FORMATS.has(format) ? "v2" : format;
}

export function computeMountPath(format: PackageFormat, orgSlug: string, repoName: string): string {
  return `${mountSegment(format)}/${orgSlug}/${repoName}`;
}

export interface CreateRepositoryInput {
  orgId: string;
  orgSlug: string;
  name: string;
  format: PackageFormat;
  kind?: "hosted" | "proxy" | "virtual";
  visibility?: Visibility;
  description?: string;
  config?: Record<string, unknown>;
}

export async function createRepository(input: CreateRepositoryInput): Promise<ResolvedRepo> {
  const mountPath = computeMountPath(input.format, input.orgSlug, input.name);
  const [row] = await db
    .insert(repositories)
    .values({
      orgId: input.orgId,
      name: input.name,
      format: input.format,
      kind: input.kind ?? "hosted",
      visibility: input.visibility ?? "private",
      mountPath,
      storagePrefix: `${input.orgId}/${input.name}`,
      description: input.description,
      config: input.config ?? {},
    })
    .returning();
  if (!row) throw new Error("failed to create repository");
  return row;
}

export async function getRepositoryById(id: string): Promise<ResolvedRepo | null> {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

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
