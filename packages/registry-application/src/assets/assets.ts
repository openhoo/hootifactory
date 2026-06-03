import { and, count, db, desc, eq, registryAssets, sql } from "@hootifactory/db";
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
      packageId: input.packageId ?? null,
      packageVersionId: input.packageVersionId ?? null,
      ociManifestId: input.ociManifestId ?? null,
      blobRefId: input.blobRefId ?? null,
      digest: input.digest,
      role: input.role,
      scope,
      path: input.path ?? null,
      mediaType: input.mediaType ?? null,
      sizeBytes: input.sizeBytes ?? 0,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        registryAssets.repositoryId,
        registryAssets.role,
        registryAssets.scope,
        registryAssets.digest,
      ],
      set: {
        packageId: input.packageId ?? null,
        packageVersionId: input.packageVersionId ?? null,
        ociManifestId: input.ociManifestId ?? null,
        blobRefId: input.blobRefId ?? null,
        path: input.path ?? null,
        mediaType: input.mediaType ?? null,
        sizeBytes: input.sizeBytes ?? 0,
        metadata: input.metadata ?? {},
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

export async function listRegistryAssetsForRepository(
  repositoryId: string,
  input: {
    packageId?: string;
    packageVersionId?: string;
    digest?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ assets: RegistryAssetRow[]; total: number }> {
  const filters = [
    eq(registryAssets.repositoryId, repositoryId),
    input.packageId ? eq(registryAssets.packageId, input.packageId) : undefined,
    input.packageVersionId
      ? eq(registryAssets.packageVersionId, input.packageVersionId)
      : undefined,
    input.digest ? eq(registryAssets.digest, input.digest) : undefined,
  ].filter((filter): filter is Exclude<typeof filter, undefined> => Boolean(filter));
  const where = filters.length > 0 ? and(...filters) : sql`true`;
  const totalRows = await db.select({ value: count() }).from(registryAssets).where(where);
  const assets = await db
    .select()
    .from(registryAssets)
    .where(where)
    .orderBy(desc(registryAssets.createdAt), desc(registryAssets.id))
    .limit(input.limit ?? 100)
    .offset(input.offset ?? 0);
  return { assets, total: totalRows[0]?.value ?? 0 };
}

export async function deleteRegistryAssetRef(
  ctx: RegistryRequestContext,
  input: { digest: string; scope: string; role?: string },
): Promise<void> {
  await db
    .delete(registryAssets)
    .where(
      and(
        eq(registryAssets.repositoryId, ctx.repo.id),
        eq(registryAssets.digest, input.digest),
        eq(registryAssets.scope, input.scope),
        input.role ? eq(registryAssets.role, input.role) : sql`true`,
      ),
    );
}
