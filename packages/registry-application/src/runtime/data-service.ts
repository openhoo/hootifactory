import type {
  RegistryAssetWriteInput,
  RegistryBlobRefInput,
  RegistryDataService,
  RegistryOciManifestHandle,
  RegistryPackageHandle,
  RegistryPackageVersionHandle,
  RegistryRequestContext,
  RegistryStoredBlob,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import { deleteRegistryAssetRef, listRegistryAssets, upsertRegistryAsset } from "../assets";
import {
  blobRefExists,
  ensureBlobRef,
  getBlobRef,
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
  listExistingOciManifestDigests,
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

function assertPackageInRepo(ctx: RegistryRequestContext, pkg: RegistryPackageHandle): void {
  if (pkg.orgId !== ctx.repo.orgId || pkg.repositoryId !== ctx.repo.id) {
    throw new Error("registry package handle does not belong to this repository");
  }
}

function assertVersionForPackage(
  pkg: RegistryPackageHandle,
  version: RegistryPackageVersionHandle,
): void {
  if (version.packageId !== pkg.id) {
    throw new Error("registry version handle does not belong to the package");
  }
}

function assertManifestInRepo(
  ctx: RegistryRequestContext,
  manifest: RegistryOciManifestHandle,
): void {
  if (manifest.repositoryId !== ctx.repo.id) {
    throw new Error("registry OCI manifest handle does not belong to this repository");
  }
}

function packageId(ctx: RegistryRequestContext, pkg: RegistryPackageHandle): string {
  assertPackageInRepo(ctx, pkg);
  return pkg.id;
}

function assetForWrite<T extends RegistryAssetWriteInput>(
  ctx: RegistryRequestContext,
  input: T,
): T {
  if (input.package) assertPackageInRepo(ctx, input.package);
  if (input.packageVersion && !input.package) {
    throw new Error("registry asset package version handle requires a package handle");
  }
  if (input.packageVersion && input.package) {
    assertVersionForPackage(input.package, input.packageVersion);
  }
  if (input.ociManifest) assertManifestInRepo(ctx, input.ociManifest);
  return input;
}

function assetWithDefaults(
  ctx: RegistryRequestContext,
  asset: RegistryAssetWriteInput | undefined,
  stored: RegistryStoredBlob,
  fallback: {
    role?: string;
    scope?: string;
    mediaType?: string;
  },
): (RegistryAssetWriteInput & { digest: string }) | null {
  if (!asset) return null;
  return assetForWrite(ctx, {
    ...asset,
    role: asset.role ?? fallback.role ?? "generic_file",
    scope: asset.scope ?? fallback.scope ?? "",
    digest: asset.digest ?? stored.digest,
    mediaType: asset.mediaType ?? fallback.mediaType ?? null,
    sizeBytes: asset.sizeBytes ?? stored.size,
  });
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
      find: (pkg, version) => findVersion(packageId(ctx, pkg), version),
      findLive: (pkg, version) => findLiveVersion(packageId(ctx, pkg), version),
      exists: (pkg, version) => packageVersionExists(packageId(ctx, pkg), version),
      listNames: (pkg) => listPackageVersionNames(packageId(ctx, pkg)),
      listLive: (pkg, opts) => listLivePackageVersions(packageId(ctx, pkg), opts),
      listRepositoryMetadata: (opts) =>
        listRepositoryVersionMetadata(ctx, {
          packageId: opts?.package ? packageId(ctx, opts.package) : undefined,
          liveOnly: opts?.liveOnly,
        }),
      create: (input) =>
        createPackageVersion(ctx, { ...input, packageId: packageId(ctx, input.package) }),
      upsert: (input) =>
        upsertPackageVersion(ctx, { ...input, packageId: packageId(ctx, input.package) }),
      upsertWithBlobRef: async (input) => {
        const result = await upsertPackageVersionWithBlobRef(ctx, {
          ...input,
          packageId: packageId(ctx, input.package),
        });
        const versionHandle = {
          id: result.versionId,
          packageId: input.package.id,
          version: input.version,
        };
        const asset = assetWithDefaults(ctx, input.blob.asset, result.stored, {
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
            package: input.package,
            packageVersion: versionHandle,
          });
        }
        return result;
      },
      commitOrReleaseBlob: async (input) => {
        const result = await commitVersionOrReleaseBlob(ctx, {
          ...input,
          packageId: packageId(ctx, input.package),
        });
        if ("conflict" in result) return result;
        const versionHandle = {
          id: result.versionId,
          packageId: input.package.id,
          version: input.version,
        };
        const asset = assetWithDefaults(ctx, input.asset, input.stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.scan.mediaType,
        });
        if (asset) {
          await upsertRegistryAsset(ctx, {
            ...asset,
            package: input.package,
            packageVersion: versionHandle,
          });
        }
        return result;
      },
      patch: (input) =>
        patchPackageVersion({
          packageId: packageId(ctx, input.package),
          version: input.version,
          patch: input.patch,
        }),
      updateMetadata: (version, metadata, opts) =>
        updatePackageVersionMetadata(version.id, metadata, opts),
      listPublishers: (pkg) => listLiveVersionPublishers(packageId(ctx, pkg)),
    },
    tags: {
      listLive: (pkg) => listLiveDistTags(packageId(ctx, pkg)),
      set: (pkg, tag, version) => {
        assertVersionForPackage(pkg, version);
        return setDistTag(packageId(ctx, pkg), tag, version.id);
      },
      delete: (pkg, tag) => deleteDistTag(packageId(ctx, pkg), tag),
      replace: (pkg, desiredTags) => {
        for (const version of desiredTags.values()) assertVersionForPackage(pkg, version);
        return replaceDistTags(
          packageId(ctx, pkg),
          new Map(
            [...desiredTags.entries()].map(([tag, version]) => [
              tag,
              { version: version.version, versionId: version.id },
            ]),
          ),
        );
      },
      updateLatestVersion: (pkg, latestVersion) =>
        updatePackageLatestVersion(packageId(ctx, pkg), latestVersion),
    },
    content: {
      isArtifactBlocked: (digest) => isArtifactBlocked(ctx, digest),
      serveBlobIfClean: (opts) => serveBlobIfClean(ctx, opts),
      blobRefExists: (input: RegistryBlobRefInput) => blobRefExists(ctx, input),
      getBlobRef: (input: RegistryBlobRefInput) => getBlobRef(ctx, input),
      storeBlobWithRef: async (input) => {
        const stored = await storeBlobWithRef(ctx, input);
        const asset = assetWithDefaults(ctx, input.asset, stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.mediaType,
        });
        if (asset) await upsertRegistryAsset(ctx, asset);
        return stored;
      },
      storeBlobStreamWithRef: async (input) => {
        const stored = await storeBlobStreamWithRef(ctx, input);
        const asset = assetWithDefaults(ctx, input.asset, stored, {
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
            ...assetForWrite(ctx, input.asset),
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
      staging: {
        putKey: (key, data) => blobStore.putAtKey(key, data),
        readKey: (key) => blobStore.readKey(key),
        bytesAtKey: (key) => blobStore.bytesAtKey(key),
        statKey: (key) => blobStore.statKey(key),
        deleteKey: (key) => blobStore.deleteKey(key),
        presignPutKey: (key, expiresIn) => blobStore.presignPutKey(key, expiresIn),
      },
    },
    assets: {
      upsert: (input) => upsertRegistryAsset(ctx, assetForWrite(ctx, input)),
      list: (input) =>
        listRegistryAssets(ctx, {
          packageId: input?.package ? packageId(ctx, input.package) : undefined,
          packageVersionId: input?.packageVersion?.id,
          digest: input?.digest,
          limit: input?.limit,
          offset: input?.offset,
        }),
    },
    oci: {
      createUploadSession: (input) => createOciUploadSession(ctx, input),
      loadUploadSession: (input) => loadOciUploadSession(ctx, input),
      withLockedUploadSession: (input) => withLockedOciUploadSession(ctx, input),
      markUploadSessionAborted: (input) => markOciUploadSessionAborted(ctx, input),
      listMountSources: listOciMountSources,
      listExistingBlobRefDigests: (input) => listExistingOciBlobRefDigests(ctx, input),
      listExistingManifestDigests: (input) =>
        listExistingOciManifestDigests(ctx, {
          packageId: packageId(ctx, input.package),
          digests: input.digests,
        }),
      blobRefExists: (input) => ociBlobRefExists(ctx, input),
      upsertManifest: (input) => upsertOciManifest(ctx, input),
      upsertTag: (input) => {
        assertPackageInRepo(ctx, input.package);
        assertManifestInRepo(ctx, input.manifest);
        return upsertOciTag(ctx, {
          packageId: input.package.id,
          tag: input.tag,
          manifestId: input.manifest.id,
        });
      },
      resolveManifest: (input) =>
        resolveOciManifest(ctx, {
          packageId: packageId(ctx, input.package),
          reference: input.reference,
        }),
      deleteTagsForManifest: (input) => {
        assertPackageInRepo(ctx, input.package);
        assertManifestInRepo(ctx, input.manifest);
        return deleteOciTagsForManifest({
          packageId: input.package.id,
          manifestId: input.manifest.id,
        });
      },
      markPackageVersionsDeletedByDigest: (input) =>
        markOciPackageVersionsDeletedByDigest({
          packageId: packageId(ctx, input.package),
          digest: input.digest,
        }),
      deleteManifestIfUnassociated: (input) => {
        assertManifestInRepo(ctx, input.manifest);
        return deleteOciManifestIfUnassociated(ctx, {
          manifestId: input.manifest.id,
          digest: input.digest,
        });
      },
      deleteTag: (input) =>
        deleteOciTag({ packageId: packageId(ctx, input.package), tag: input.tag }),
      listLiveManifestsForPackage: (pkg) =>
        listLiveOciManifestsForPackage(ctx, packageId(ctx, pkg)),
      listTags: (pkg) => listOciTags(packageId(ctx, pkg)),
      listSubjectManifests: (subjectDigest) => listOciSubjectManifests(ctx, subjectDigest),
    },
  };
}

export { publisherOf };
