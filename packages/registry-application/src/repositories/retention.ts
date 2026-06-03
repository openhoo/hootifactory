import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  packages,
  packageVersions,
  repositories,
  versionTags,
} from "@hootifactory/db";
import { z } from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import { deleteUnreferencedCasBlob, releaseRepoDigestTx } from "../content";

const DigestRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const DigestObjectSchema = z.looseObject({ blobDigest: DigestRefSchema });
const VersionDigestFieldsSchema = z.looseObject({
  dist: z.unknown().optional(),
  crateDigest: z.unknown().optional(),
  zipDigest: z.unknown().optional(),
  nupkgDigest: z.unknown().optional(),
  files: z.unknown().optional(),
});

/**
 * Extract the CAS blob digests a stored version references, across formats
 * (npm dist, pypi files, cargo crate, go zip, nuget nupkg). Docker layer refs
 * are scoped to the image (not the version) and are reclaimed via the adapter's
 * delete path, so they are intentionally not covered here.
 */
export function versionBlobDigests(metadata: unknown): string[] {
  const out = new Set<string>();
  const parsed = VersionDigestFieldsSchema.safeParse(metadata ?? {});
  if (!parsed.success) return [];
  const m = parsed.data;
  const add = (v: unknown) => {
    const digest = DigestRefSchema.safeParse(v);
    if (digest.success) out.add(digest.data);
  };

  const dist = DigestObjectSchema.safeParse(m.dist);
  if (dist.success) add(dist.data.blobDigest); // npm
  add(m.crateDigest); // cargo
  add(m.zipDigest); // go
  add(m.nupkgDigest); // nuget
  const files = z.array(z.unknown()).safeParse(m.files);
  if (files.success) {
    for (const file of files.data) {
      const parsedFile = DigestObjectSchema.safeParse(file);
      if (parsedFile.success) add(parsedFile.data.blobDigest); // pypi
    }
  }
  return [...out];
}

/** Fan-in the blob digests referenced across a set of version rows. */
function collectVersionDigests(rows: { metadata: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const d of versionBlobDigests(r.metadata)) out.add(d);
  return out;
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
      for (const d of collectVersionDigests(toPrune)) prunedDigests.add(d);

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
      // Digests still referenced by a surviving live version must be kept.
      const live = await tx
        .select({ metadata: packageVersions.metadata })
        .from(packageVersions)
        .innerJoin(packages, eq(packageVersions.packageId, packages.id))
        .where(and(eq(packages.repositoryId, repositoryId), isNull(packageVersions.deletedAt)));
      const liveDigests = collectVersionDigests(live);

      for (const digest of prunedDigests) {
        if (liveDigests.has(digest)) continue;
        const reaped = await releaseRepoDigestTx(tx, { repositoryId, orgId: repo.orgId, digest });
        if (reaped) casToDelete.push(reaped);
      }
    }
    return count;
  });

  // Delete reclaimed objects from the CAS only if no concurrent upload reactivated them.
  for (const digest of casToDelete) await deleteUnreferencedCasBlob({ blobs: blobStore }, digest);
  return pruned;
}
