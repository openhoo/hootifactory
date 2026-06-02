import {
  and,
  asc,
  db,
  desc,
  eq,
  inArray,
  isNull,
  packages,
  packageVersions,
  repositories,
  repositoryUpstreams,
  versionTags,
  virtualRepoMembers,
} from "@hootifactory/db";
import { blobStore } from "@hootifactory/storage";
import type { PackageFormat, Visibility } from "@hootifactory/types";
import type { ResolvedRepo } from "./format/adapter";
import { releaseRepoDigestTx } from "./service";

const V2_FORMATS = new Set<PackageFormat>(["docker", "oci", "helm"]);
const OCI_REPOSITORY_NAME_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

/** First URL segment for a format: "v2" for OCI-based, else the format name. */
export function mountSegment(format: PackageFormat): string {
  return V2_FORMATS.has(format) ? "v2" : format;
}

export function computeMountPath(format: PackageFormat, orgSlug: string, repoName: string): string {
  return `${mountSegment(format)}/${orgSlug}/${repoName}`;
}

export function isValidRepositoryName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function isValidRepositoryNameForFormat(format: PackageFormat, name: string): boolean {
  if (!isValidRepositoryName(name)) return false;
  return V2_FORMATS.has(format) ? OCI_REPOSITORY_NAME_RE.test(name) : true;
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

/** Member repos of a virtual repo, in resolution order. */
export async function loadVirtualMembers(virtualRepoId: string): Promise<ResolvedRepo[]> {
  const rows = await db
    .select({ repo: repositories })
    .from(virtualRepoMembers)
    .innerJoin(repositories, eq(virtualRepoMembers.memberRepoId, repositories.id))
    .where(eq(virtualRepoMembers.virtualRepoId, virtualRepoId))
    .orderBy(asc(virtualRepoMembers.position));
  return rows.map((r) => r.repo);
}

export interface Upstream {
  url: string;
  credentials: Record<string, unknown> | null;
}

/** Highest-priority upstream for a proxy repo. */
export async function loadUpstream(repoId: string): Promise<Upstream | null> {
  const [row] = await db
    .select({ url: repositoryUpstreams.url, credentials: repositoryUpstreams.credentials })
    .from(repositoryUpstreams)
    .where(eq(repositoryUpstreams.repositoryId, repoId))
    .orderBy(asc(repositoryUpstreams.priority))
    .limit(1);
  return row ?? null;
}

export async function addVirtualMember(virtualRepoId: string, memberRepoId: string, position = 0) {
  await db
    .insert(virtualRepoMembers)
    .values({ virtualRepoId, memberRepoId, position })
    .onConflictDoNothing();
}

export async function addUpstream(repositoryId: string, url: string, priority = 0) {
  await db.insert(repositoryUpstreams).values({ repositoryId, url, priority });
}

/**
 * Extract the CAS blob digests a stored version references, across formats
 * (npm dist, pypi files, cargo crate, go zip, nuget nupkg). Docker layer refs
 * are scoped to the image (not the version) and are reclaimed via the adapter's
 * delete path, so they are intentionally not covered here.
 */
function versionBlobDigests(metadata: unknown): string[] {
  const out = new Set<string>();
  const m = (metadata ?? {}) as Record<string, unknown>;
  const add = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("sha256:")) out.add(v);
  };
  add((m.dist as { blobDigest?: unknown } | undefined)?.blobDigest); // npm
  add(m.crateDigest); // cargo
  add(m.zipDigest); // go
  add(m.nupkgDigest); // nuget
  for (const f of (m.files as { blobDigest?: unknown }[] | undefined) ?? []) add(f?.blobDigest); // pypi
  return [...out];
}

/**
 * Soft-delete versions beyond the newest `keepLastN` per package, atomically,
 * and reclaim blob references (and CAS bytes/quota) for any digest no surviving
 * version still needs. Returns count pruned.
 */
export async function applyRetention(repositoryId: string, keepLastN: number): Promise<number> {
  const [repo] = await db
    .select({ orgId: repositories.orgId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repo) return 0;

  const casToDelete: string[] = [];
  const pruned = await db.transaction(async (tx) => {
    const pkgs = await tx
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.repositoryId, repositoryId));

    const prunedDigests = new Set<string>();
    let count = 0;
    for (const p of pkgs) {
      const vers = await tx
        .select({
          id: packageVersions.id,
          version: packageVersions.version,
          metadata: packageVersions.metadata,
        })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, p.id), isNull(packageVersions.deletedAt)))
        // Deterministic ordering with an id tie-break so equal timestamps prune stably.
        .orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));
      const survivors = vers.slice(0, keepLastN);
      const toPrune = vers.slice(keepLastN);
      if (toPrune.length === 0) continue;
      const prunedIds = toPrune.map((v) => v.id);
      await tx
        .update(packageVersions)
        .set({ deletedAt: new Date() })
        .where(inArray(packageVersions.id, prunedIds));
      count += toPrune.length;
      for (const v of toPrune) for (const d of versionBlobDigests(v.metadata)) prunedDigests.add(d);

      const deletedTags = await tx
        .delete(versionTags)
        .where(and(eq(versionTags.packageId, p.id), inArray(versionTags.versionId, prunedIds)))
        .returning({ tag: versionTags.tag });
      const latest = survivors[0] ?? null;
      await tx
        .update(packages)
        .set({ latestVersion: latest?.version ?? null })
        .where(eq(packages.id, p.id));
      if (latest && deletedTags.some((t) => t.tag === "latest")) {
        await tx
          .insert(versionTags)
          .values({ packageId: p.id, tag: "latest", versionId: latest.id })
          .onConflictDoUpdate({
            target: [versionTags.packageId, versionTags.tag],
            set: { versionId: latest.id },
          });
      }
    }

    if (prunedDigests.size > 0) {
      // Digests still referenced by a surviving (live) version must be kept.
      const live = await tx
        .select({ metadata: packageVersions.metadata })
        .from(packageVersions)
        .innerJoin(packages, eq(packageVersions.packageId, packages.id))
        .where(and(eq(packages.repositoryId, repositoryId), isNull(packageVersions.deletedAt)));
      const liveDigests = new Set<string>();
      for (const r of live) for (const d of versionBlobDigests(r.metadata)) liveDigests.add(d);

      for (const digest of prunedDigests) {
        if (liveDigests.has(digest)) continue;
        const reaped = await releaseRepoDigestTx(tx, { repositoryId, orgId: repo.orgId, digest });
        if (reaped) casToDelete.push(reaped);
      }
    }
    return count;
  });

  // Delete reclaimed objects from the CAS after the DB transaction commits.
  for (const digest of casToDelete) await blobStore.delete(digest).catch(() => {});
  return pruned;
}
