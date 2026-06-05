import {
  and,
  db,
  eq,
  isNull,
  packages,
  packageVersions,
  repositories,
  sql,
} from "@hootifactory/db";
import { DIGEST_RE, registryPlugins, z } from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import { deleteUnreferencedCasBlob } from "../content";
import { adjustArtifactsUsedTx, adjustStorageUsedTx } from "../governance/quota";
import {
  booleanField,
  fieldValue,
  numberField,
  rowsFromExecute,
  stringField,
} from "../runtime/raw-rows";

const DigestRefSchema = z.string().regex(DIGEST_RE);

/** Extracts a module's metadata-referenced CAS blob digest candidates. */
export type VersionDigestExtractor = (metadata: Record<string, unknown>) => string[];

/**
 * Validate and dedup the CAS blob digests a module reports for a version's
 * metadata. The format-specific metadata shape is owned by the module (via its
 * scan provider's referencedDigests); this agnostic layer only validates that
 * the reported strings are well-formed digests.
 */
export function versionBlobDigests(metadata: unknown, extract: VersionDigestExtractor): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const out = new Set<string>();
  for (const candidate of extract(metadata as Record<string, unknown>)) {
    if (DigestRefSchema.safeParse(candidate).success) out.add(candidate);
  }
  return [...out];
}

/** Fan-in the blob digests referenced across a set of version rows. */
function collectVersionDigests(
  rows: { metadata: unknown }[],
  extract: VersionDigestExtractor,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const d of versionBlobDigests(r.metadata, extract)) out.add(d);
  return out;
}

/** The module's metadata digest extractor (no-op when the module declares none). */
function digestExtractorFor(moduleId: string): VersionDigestExtractor {
  return registryPlugins.lookup(moduleId)?.scan?.referencedDigests ?? (() => []);
}

function metadataField(row: unknown): unknown {
  return fieldValue(row, "metadata");
}

function uuidValueRows(values: string[]) {
  return sql.join(
    values.map((value) => sql`(${value}::uuid)`),
    sql`, `,
  );
}

function textValueRows(values: string[]) {
  return sql.join(
    values.map((value) => sql`(${value}::text)`),
    sql`, `,
  );
}

/**
 * Soft-delete versions beyond the newest `keepLastN` per package, atomically,
 * and reclaim blob references (and CAS bytes/quota) for any digest no surviving
 * version still needs. Returns count pruned.
 */
export async function applyRetention(repositoryId: string, keepLastN: number): Promise<number> {
  const [repo] = await db
    .select({ orgId: repositories.orgId, moduleId: repositories.moduleId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repo) return 0;
  const extractDigests = digestExtractorFor(repo.moduleId);

  const casToDelete: string[] = [];
  const pruned = await db.transaction(async (tx) => {
    const now = new Date();
    const prunedRows = rowsFromExecute(
      await tx.execute(sql`
        with ranked as (
          select
            pv.id,
            pv.package_id as "packageId",
            pv.metadata,
            row_number() over (
              partition by pv.package_id
              order by pv.created_at desc, pv.id desc
            ) as rn
          from package_versions pv
          inner join packages p on p.id = pv.package_id
          where p.repository_id = ${repositoryId}
            and pv.deleted_at is null
        ),
        prune_set as (
          select id, "packageId", metadata
          from ranked
          where rn > ${keepLastN}
        )
        update package_versions pv
        set deleted_at = ${now}, updated_at = ${now}
        from prune_set
        where pv.id = prune_set.id
        returning pv.id, pv.package_id as "packageId", pv.metadata
      `),
    );
    if (prunedRows.length === 0) return 0;

    const prunedIds = prunedRows.flatMap((row) => {
      const id = stringField(row, "id");
      return id ? [id] : [];
    });
    const prunedPackageIds = [
      ...new Set(
        prunedRows.flatMap((row) => {
          const id = stringField(row, "packageId");
          return id ? [id] : [];
        }),
      ),
    ];
    // collectVersionDigests returns a fresh Set; reuse it directly (it stays
    // mutable for the asset-digest additions below).
    const prunedDigests = collectVersionDigests(
      prunedRows.map((row) => ({ metadata: metadataField(row) })),
      extractDigests,
    );

    await adjustArtifactsUsedTx(tx, repo.orgId, -prunedRows.length);

    const prunedAssets = rowsFromExecute(
      await tx.execute(sql`
        with pruned_ids(id) as (
          values ${uuidValueRows(prunedIds)}
        )
        update registry_assets
        set deleted_at = ${now}, updated_at = ${now}
        where registry_assets.repository_id = ${repositoryId}
          and registry_assets.package_version_id in (select id from pruned_ids)
          and registry_assets.deleted_at is null
        returning digest
      `),
    );
    for (const asset of prunedAssets) {
      const digest = stringField(asset, "digest");
      if (digest) prunedDigests.add(digest);
    }

    const deletedTags = rowsFromExecute(
      await tx.execute(sql`
        with pruned_ids(id) as (
          values ${uuidValueRows(prunedIds)}
        )
        delete from version_tags
        where version_id in (select id from pruned_ids)
        returning package_id as "packageId", tag
      `),
    );

    await tx.execute(sql`
      with affected(package_id) as (
        values ${uuidValueRows(prunedPackageIds)}
      ),
      latest as (
        select distinct on (pv.package_id)
          pv.package_id,
          pv.id,
          pv.version
        from package_versions pv
        inner join affected a on a.package_id = pv.package_id
        where pv.deleted_at is null
        order by pv.package_id, pv.created_at desc, pv.id desc
      )
      update packages p
      set latest_version = latest.version, updated_at = ${now}
      from affected a
      left join latest on latest.package_id = a.package_id
      where p.id = a.package_id
    `);

    const latestTagPackageIds = [
      ...new Set(
        deletedTags.flatMap((row) => {
          const tag = stringField(row, "tag");
          const packageId = stringField(row, "packageId");
          return tag === "latest" && packageId ? [packageId] : [];
        }),
      ),
    ];
    if (latestTagPackageIds.length > 0) {
      await tx.execute(sql`
        with affected(package_id) as (
          values ${uuidValueRows(latestTagPackageIds)}
        ),
        latest as (
          select distinct on (pv.package_id)
            pv.package_id,
            pv.id
          from package_versions pv
          inner join affected a on a.package_id = pv.package_id
          where pv.deleted_at is null
          order by pv.package_id, pv.created_at desc, pv.id desc
        )
        insert into version_tags (package_id, tag, version_id, created_at, updated_at)
        select package_id, 'latest', id, ${now}, ${now}
        from latest
        on conflict (package_id, tag) do update
          set version_id = excluded.version_id, updated_at = ${now}
      `);
    }

    if (prunedDigests.size > 0) {
      // Digests still referenced by a surviving live asset/version must be kept.
      const prunedDigestList = [...prunedDigests];
      const liveAssets = rowsFromExecute(
        await tx.execute(sql`
          with candidate_digests(digest) as (
            values ${textValueRows(prunedDigestList)}
          )
          select distinct digest
          from registry_assets
          where repository_id = ${repositoryId}
            and deleted_at is null
            and digest in (select digest from candidate_digests)
        `),
      );
      const liveDigests = new Set(
        liveAssets.flatMap((asset) => {
          const digest = stringField(asset, "digest");
          return digest ? [digest] : [];
        }),
      );
      const liveVersions = await tx
        .select({ metadata: packageVersions.metadata })
        .from(packageVersions)
        .innerJoin(packages, eq(packageVersions.packageId, packages.id))
        .where(and(eq(packages.repositoryId, repositoryId), isNull(packageVersions.deletedAt)));
      for (const digest of collectVersionDigests(liveVersions, extractDigests)) {
        liveDigests.add(digest);
      }

      const releaseDigests = prunedDigestList.filter((digest) => !liveDigests.has(digest)).sort();
      if (releaseDigests.length > 0) {
        await tx.execute(sql`
          with candidate_digests(digest) as (
            values ${textValueRows(releaseDigests)}
          )
          select pg_advisory_xact_lock(hashtextextended(digest, 0))
          from candidate_digests
          order by digest
        `);
        const deletedRefs = rowsFromExecute(
          await tx.execute(sql`
            with candidate_digests(digest) as (
              values ${textValueRows(releaseDigests)}
            )
            delete from blob_refs br
            using candidate_digests
            where br.repository_id = ${repositoryId}
              and br.digest = candidate_digests.digest
            returning br.digest
          `),
        );
        const releasedDigests = [
          ...new Set(
            deletedRefs.flatMap((row) => {
              const digest = stringField(row, "digest");
              return digest ? [digest] : [];
            }),
          ),
        ];
        if (releasedDigests.length > 0) {
          const releasedBlobs = rowsFromExecute(
            await tx.execute(sql`
              with released_digests(digest) as (
                values ${textValueRows(releasedDigests)}
              )
              select
                b.digest,
                b.ref_count as "refCount",
                b.size_bytes as "sizeBytes",
                exists (
                  select 1
                  from blob_refs br
                  inner join repositories r on r.id = br.repository_id
                  where r.org_id = ${repo.orgId}
                    and br.digest = b.digest
                ) as "stillReferencedByOrg"
              from blobs b
              inner join released_digests on released_digests.digest = b.digest
            `),
          );
          let storageDelta = 0;
          for (const row of releasedBlobs) {
            if (!booleanField(row, "stillReferencedByOrg")) {
              storageDelta -= numberField(row, "sizeBytes") ?? 0;
            }
            if ((numberField(row, "refCount") ?? 1) <= 0) {
              const digest = stringField(row, "digest");
              if (digest) casToDelete.push(digest);
            }
          }
          if (storageDelta !== 0) await adjustStorageUsedTx(tx, repo.orgId, storageDelta);
        }
      }
    }
    return prunedRows.length;
  });

  // Delete reclaimed objects from the CAS only if no concurrent upload reactivated them.
  for (const digest of casToDelete) await deleteUnreferencedCasBlob({ blobs: blobStore }, digest);
  return pruned;
}
