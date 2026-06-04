import { and, count, db, desc, eq, isNull, registryAssets, sql } from "@hootifactory/db";
import type {
  RegistryAssetRow,
  RegistryAssetWriteInput,
  RegistryRequestContext,
} from "@hootifactory/registry";

export async function upsertRegistryAsset(
  ctx: RegistryRequestContext,
  input: RegistryAssetWriteInput & { digest: string },
): Promise<RegistryAssetRow> {
  const scope = input.scope ?? "";
  const [row] = await db
    .insert(registryAssets)
    .values({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      packageId: input.package?.id ?? null,
      packageVersionId: input.packageVersion?.id ?? null,
      ociManifestId: input.ociManifest?.id ?? null,
      blobRefId: input.blobRefId ?? null,
      digest: input.digest,
      role: input.role,
      scope,
      path: input.path ?? null,
      mediaType: input.mediaType ?? null,
      sizeBytes: input.sizeBytes ?? 0,
      metadata: input.metadata ?? {},
      deletedAt: null,
    })
    .onConflictDoUpdate({
      target: [
        registryAssets.repositoryId,
        registryAssets.role,
        registryAssets.scope,
        registryAssets.digest,
      ],
      set: {
        packageId: input.package?.id ?? null,
        packageVersionId: input.packageVersion?.id ?? null,
        ociManifestId: input.ociManifest?.id ?? null,
        blobRefId: input.blobRefId ?? null,
        path: input.path ?? null,
        mediaType: input.mediaType ?? null,
        sizeBytes: input.sizeBytes ?? 0,
        metadata: input.metadata ?? {},
        deletedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("failed to upsert registry asset");
  return row;
}

export async function listRegistryAssets(
  ctx: RegistryRequestContext,
  input: {
    packageId?: string;
    packageVersionId?: string;
    digest?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ assets: RegistryAssetRow[]; total: number }> {
  return listRegistryAssetsForRepository(ctx.repo.id, input);
}

type RegistryAssetListInput = {
  packageId?: string;
  packageVersionId?: string;
  digest?: string;
  limit?: number;
  offset?: number;
  withTotal?: boolean;
};

type RegistryAssetListResult = { assets: RegistryAssetRow[]; total: number };

export function listRegistryAssetsForRepository(
  repositoryId: string,
  input: RegistryAssetListInput & { withTotal: false },
): Promise<{ assets: RegistryAssetRow[] }>;
export function listRegistryAssetsForRepository(
  repositoryId: string,
  input?: RegistryAssetListInput,
): Promise<RegistryAssetListResult>;
export async function listRegistryAssetsForRepository(
  repositoryId: string,
  input: RegistryAssetListInput = {},
): Promise<{ assets: RegistryAssetRow[]; total?: number }> {
  const filters = [
    eq(registryAssets.repositoryId, repositoryId),
    isNull(registryAssets.deletedAt),
    input.packageId ? eq(registryAssets.packageId, input.packageId) : undefined,
    input.packageVersionId
      ? eq(registryAssets.packageVersionId, input.packageVersionId)
      : undefined,
    input.digest ? eq(registryAssets.digest, input.digest) : undefined,
  ].filter((filter): filter is Exclude<typeof filter, undefined> => Boolean(filter));
  const where = filters.length > 0 ? and(...filters) : sql`true`;
  const assetsQuery = db
    .select()
    .from(registryAssets)
    .where(where)
    .orderBy(desc(registryAssets.createdAt), desc(registryAssets.id))
    .limit(input.limit ?? 100)
    .offset(input.offset ?? 0);
  if (input.withTotal === false) {
    return { assets: await assetsQuery };
  }
  const [totalRows, assets] = await Promise.all([
    db.select({ value: count() }).from(registryAssets).where(where),
    assetsQuery,
  ]);
  return { assets, total: totalRows[0]?.value ?? 0 };
}

export async function deleteRegistryAssetRef(
  ctx: RegistryRequestContext,
  input: { digest: string; scope: string; role?: string },
): Promise<void> {
  await db
    .update(registryAssets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(registryAssets.repositoryId, ctx.repo.id),
        eq(registryAssets.digest, input.digest),
        eq(registryAssets.scope, input.scope),
        isNull(registryAssets.deletedAt),
        input.role ? eq(registryAssets.role, input.role) : sql`true`,
      ),
    );
}
