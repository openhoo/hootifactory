import type {
  RegistryAssetWriteInput,
  RegistryDataService,
  RegistryRequestContext,
  RegistryStoredBlob,
} from "@hootifactory/registry";
import { deleteRegistryAssetRef, listRegistryAssets, upsertRegistryAsset } from "../assets";
import {
  ensureBlobRef,
  isArtifactBlocked,
  releaseBlobRef,
  serveBlobIfClean,
  storeBlobStreamWithRef,
  storeBlobWithRef,
} from "../content";
import {
  deleteOciManifestIfUnassociated,
  deleteOciTag,
  deleteOciTagsForManifest,
  listExistingOciBlobRefDigests,
  listLiveOciManifestsForPackage,
  listOciSubjectManifests,
  listOciTags,
  markOciPackageVersionsDeletedByDigest,
  ociBlobRefExists,
  resolveOciManifest,
  upsertOciManifest,
  upsertOciTag,
} from "../oci/manifests";
import {
  createOciUploadSession,
  listOciMountSources,
  loadOciUploadSession,
  markOciUploadSessionAborted,
  withLockedOciUploadSession,
} from "../oci/uploads";
import {
  deleteDistTag,
  listLiveDistTags,
  listLivePackageVersions,
  listLiveVersionPublishers,
  listPackageVersionNames,
  listRepositoryPackageNames,
  listRepositoryPackages,
  listRepositoryVersionMetadata,
  packageVersionExists,
  patchPackageVersion,
  replaceDistTags,
  searchRepositoryPackages,
  updatePackageLatestVersion,
  updatePackageVersionMetadata,
} from "../packages/queries";
import {
  commitVersionOrReleaseBlob,
  createPackageVersion,
  publisherOf,
  setDistTag,
  upsertPackageVersion,
  upsertPackageVersionWithBlobRef,
} from "../packages/versions";
import {
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  findVersion,
} from "../repositories";

function assetWithDefaults(
  asset: RegistryAssetWriteInput | undefined,
  stored: RegistryStoredBlob,
  fallback: {
    role?: string;
    scope?: string;
    mediaType?: string;
  },
): (RegistryAssetWriteInput & { digest: string }) | null {
  if (!asset) return null;
  return {
    ...asset,
    role: asset.role ?? fallback.role ?? "generic_file",
    scope: asset.scope ?? fallback.scope ?? "",
    digest: asset.digest ?? stored.digest,
    mediaType: asset.mediaType ?? fallback.mediaType ?? null,
    sizeBytes: asset.sizeBytes ?? stored.size,
  };
}

function assetRoleForBlobKind(kind: string): string | undefined {
  if (kind === "oci_layer") return "oci_layer";
  if (kind === "oci_config") return "oci_config";
  if (kind === "oci_manifest") return "oci_manifest";
  if (kind === "npm_tarball") return "npm_tarball";
  if (kind === "pypi_file") return "pypi_file";
  return undefined;
}

export function replacedAssetRef(input: {
  previousDigest?: string | null;
  currentDigest: string;
  kind: string;
  scope: string;
  asset?: RegistryAssetWriteInput;
}): { digest: string; scope: string; role?: string } | null {
  if (!input.previousDigest || input.previousDigest === input.currentDigest) return null;
  return {
    digest: input.previousDigest,
    scope: input.asset?.scope ?? input.scope,
    role: input.asset?.role ?? assetRoleForBlobKind(input.kind),
  };
}

async function deleteReplacedAssetRef(
  ctx: RegistryRequestContext,
  input: Parameters<typeof replacedAssetRef>[0],
): Promise<void> {
  const ref = replacedAssetRef(input);
  if (!ref) return;
  await deleteRegistryAssetRef(ctx, ref);
}

export function createRegistryDataService(ctx: RegistryRequestContext): RegistryDataService {
  return {
    packages: {
      findByName: (name) => findPackageByName(ctx, name),
      findOrCreate: (input) =>
        findOrCreatePackage({
          orgId: ctx.repo.orgId,
          repositoryId: ctx.repo.id,
          name: input.name,
          namespace: input.namespace,
        }),
      listNames: () => listRepositoryPackageNames(ctx),
      list: () => listRepositoryPackages(ctx),
      search: (input) => searchRepositoryPackages(ctx, input),
    },
    versions: {
      find: findVersion,
      findLive: findLiveVersion,
      exists: packageVersionExists,
      listNames: listPackageVersionNames,
      listLive: listLivePackageVersions,
      listRepositoryMetadata: (opts) => listRepositoryVersionMetadata(ctx, opts),
      create: (input) => createPackageVersion(ctx, input),
      upsert: (input) => upsertPackageVersion(ctx, input),
      upsertWithBlobRef: async (input) => {
        const result = await upsertPackageVersionWithBlobRef(ctx, input);
        const asset = assetWithDefaults(input.blob.asset, result.stored, {
          role: input.blob.kind,
          scope: input.blob.scope,
          mediaType: input.blob.mediaType,
        });
        if (asset) {
          await deleteReplacedAssetRef(ctx, {
            previousDigest: input.blob.previousDigest,
            currentDigest: result.stored.digest,
            kind: input.blob.kind,
            scope: input.blob.scope,
            asset,
          });
          await upsertRegistryAsset(ctx, {
            ...asset,
            packageId: input.packageId,
            packageVersionId: result.versionId,
          });
        }
        return result;
      },
      commitOrReleaseBlob: async (input) => {
        const result = await commitVersionOrReleaseBlob(ctx, input);
        if ("conflict" in result) return result;
        const asset = assetWithDefaults(input.asset, input.stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.scan.mediaType,
        });
        if (asset) {
          await upsertRegistryAsset(ctx, {
            ...asset,
            packageId: input.packageId,
            packageVersionId: result.versionId,
          });
        }
        return result;
      },
      patch: patchPackageVersion,
      updateMetadata: updatePackageVersionMetadata,
      listPublishers: listLiveVersionPublishers,
    },
    tags: {
      listLive: listLiveDistTags,
      set: setDistTag,
      delete: deleteDistTag,
      replace: replaceDistTags,
      updateLatestVersion: updatePackageLatestVersion,
    },
    content: {
      isArtifactBlocked: (digest) => isArtifactBlocked(ctx, digest),
      serveBlobIfClean: (opts) => serveBlobIfClean(ctx, opts),
      storeBlobWithRef: async (input) => {
        const stored = await storeBlobWithRef(ctx, input);
        const asset = assetWithDefaults(input.asset, stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.mediaType,
        });
        if (asset) await upsertRegistryAsset(ctx, asset);
        return stored;
      },
      storeBlobStreamWithRef: async (input) => {
        const stored = await storeBlobStreamWithRef(ctx, input);
        const asset = assetWithDefaults(input.asset, stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.mediaType,
        });
        if (asset) await upsertRegistryAsset(ctx, asset);
        return stored;
      },
      ensureBlobRef: async (input) => {
        await ensureBlobRef(ctx, input);
        if (input.asset) {
          await upsertRegistryAsset(ctx, {
            ...input.asset,
            digest: input.digest,
            role: input.asset.role ?? input.kind,
            scope: input.asset.scope ?? input.scope,
          });
        }
      },
      releaseBlobRef: async (input) => {
        await releaseBlobRef(ctx, input);
        await deleteRegistryAssetRef(ctx, {
          digest: input.digest,
          scope: input.scope,
          role: assetRoleForBlobKind(input.kind),
        });
      },
    },
    assets: {
      upsert: (input) => upsertRegistryAsset(ctx, input),
      list: (input) => listRegistryAssets(ctx, input),
    },
    oci: {
      createUploadSession: (input) => createOciUploadSession(ctx, input),
      loadUploadSession: (input) => loadOciUploadSession(ctx, input),
      withLockedUploadSession: (input) => withLockedOciUploadSession(ctx, input),
      markUploadSessionAborted: (input) => markOciUploadSessionAborted(ctx, input),
      listMountSources: listOciMountSources,
      listExistingBlobRefDigests: (input) => listExistingOciBlobRefDigests(ctx, input),
      blobRefExists: (input) => ociBlobRefExists(ctx, input),
      upsertManifest: (input) => upsertOciManifest(ctx, input),
      upsertTag: (input) => upsertOciTag(ctx, input),
      resolveManifest: (input) => resolveOciManifest(ctx, input),
      deleteTagsForManifest: deleteOciTagsForManifest,
      markPackageVersionsDeletedByDigest: markOciPackageVersionsDeletedByDigest,
      deleteManifestIfUnassociated: (input) => deleteOciManifestIfUnassociated(ctx, input),
      deleteTag: deleteOciTag,
      listLiveManifestsForPackage: (packageId) => listLiveOciManifestsForPackage(ctx, packageId),
      listTags: listOciTags,
      listSubjectManifests: (subjectDigest) => listOciSubjectManifests(ctx, subjectDigest),
    },
  };
}

export { publisherOf };
