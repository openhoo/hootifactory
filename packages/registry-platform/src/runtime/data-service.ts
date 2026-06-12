import { env } from "@hootifactory/config";
import { db } from "@hootifactory/db";
import { captureTelemetryContext } from "@hootifactory/observability";
import type {
  ContentAddressableRegistryDataService,
  RegistryBlobRefInput,
  RegistryRequestContext,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import {
  deleteRegistryAssetRef,
  findRegistryAssetByScope,
  listRegistryAssets,
  upsertRegistryAsset,
} from "../assets";
import {
  areAllArtifactsBlocked,
  blobRefExists,
  discardUncommittedBlobPut,
  ensureBlobRef,
  getBlobRef,
  isArtifactBlocked,
  releaseBlobRef,
  serveBlobIfClean,
  storeBlobStreamWithRef,
  storeBlobWithRef,
  uploadBlobStream,
} from "../content";
import {
  commitContentManifest,
  contentBlobRefExists,
  deleteContentManifestIfUnassociated,
  deleteContentTag,
  deleteContentTagsForManifest,
  listContentManifestDigestsReferencingBlob,
  listContentSubjectManifests,
  listContentTags,
  listExistingContentBlobRefDigests,
  listExistingContentManifestDigests,
  listLiveContentManifestsForPackage,
  markContentPackageVersionsDeletedByDigest,
  replaceContentManifestBlobRefs,
  resolveContentManifest,
} from "../content/manifest-store";
import {
  createContentUploadSession,
  listContentMountSources,
  loadContentUploadSession,
  markContentUploadSessionAborted,
  withLockedContentUploadSession,
} from "../content/upload-sessions";
import {
  deleteDistTag,
  listLiveDistTags,
  listLiveDistTagsForPackages,
  listLivePackageVersionFingerprints,
  listLivePackageVersionNames,
  listLivePackageVersions,
  listLivePackageVersionsForPackages,
  listLiveVersionPublishers,
  listPackageVersionNames,
  listRepositoryPackageNames,
  listRepositoryPackages,
  listRepositoryVersionMetadata,
  listSearchPackageVersionsForPackages,
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
import {
  assertManifestInRepo,
  assertPackageInRepo,
  assertVersionForPackage,
  assetForWrite,
  assetWithDefaults,
  deleteReplacedAssetRef,
  packageId,
} from "./data-service-helpers";
import { recordArtifactScanOutbox } from "./scan-outbox";

async function upsertAssetWithOptionalScan(
  ctx: RegistryRequestContext,
  asset: ReturnType<typeof assetForWrite> & { digest: string },
  scan?: { name?: string; version?: string; mediaType?: string },
) {
  if (!scan || !env.SCANNER_ENABLED) return upsertRegistryAsset(ctx, asset);
  return db.transaction(async (tx) => {
    const row = await upsertRegistryAsset(ctx, asset, tx);
    await recordArtifactScanOutbox(
      ctx.repo,
      { digest: asset.digest, ...scan },
      () => captureTelemetryContext(),
      tx,
    );
    return row;
  });
}

export function createRegistryDataService(
  ctx: RegistryRequestContext,
): ContentAddressableRegistryDataService {
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
      listLiveForPackages: (pkgs, opts) =>
        listLivePackageVersionsForPackages(
          pkgs.map((pkg) => packageId(ctx, pkg)),
          opts,
        ),
      listSearchVersionsForPackages: (pkgs, preferredVersionsByPackageId) =>
        listSearchPackageVersionsForPackages(
          pkgs.map((pkg) => packageId(ctx, pkg)),
          preferredVersionsByPackageId,
        ),
      listLiveFingerprints: (pkg) => listLivePackageVersionFingerprints(packageId(ctx, pkg)),
      listRepositoryMetadata: (opts) =>
        listRepositoryVersionMetadata(ctx, {
          packageId: opts?.package ? packageId(ctx, opts.package) : undefined,
          liveOnly: opts?.liveOnly,
        }),
      listLiveNames: (pkg, opts) => listLivePackageVersionNames(packageId(ctx, pkg), opts),
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
      markPackageVersionsDeletedByDigest: (input) =>
        markContentPackageVersionsDeletedByDigest({
          orgId: ctx.repo.orgId,
          packageId: packageId(ctx, input.package),
          digest: input.digest,
        }),
    },
    tags: {
      listLive: (pkg) => listLiveDistTags(packageId(ctx, pkg)),
      listLiveForPackages: (pkgs) =>
        listLiveDistTagsForPackages(pkgs.map((pkg) => packageId(ctx, pkg))),
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
      areAllArtifactsBlocked: (digests) => areAllArtifactsBlocked(ctx, digests),
      serveBlobIfClean: (opts) => serveBlobIfClean(ctx, opts),
      uploadBlobStream: (input) => uploadBlobStream(input.data, input.expectedDigest),
      discardUploadedBlob: (blob) => discardUncommittedBlobPut(ctx, blob),
      blobRefExists: (input: RegistryBlobRefInput) => blobRefExists(ctx, input),
      getBlobRef: (input: RegistryBlobRefInput) => getBlobRef(ctx, input),
      storeBlobWithRef: async (input) => {
        const stored = await storeBlobWithRef(ctx, input);
        const asset = assetWithDefaults(ctx, input.asset, stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.mediaType,
        });
        if (asset) await upsertAssetWithOptionalScan(ctx, asset, input.asset?.scan);
        return stored;
      },
      storeBlobStreamWithRef: async (input) => {
        const stored = await storeBlobStreamWithRef(ctx, input);
        const asset = assetWithDefaults(ctx, input.asset, stored, {
          role: input.kind,
          scope: input.scope,
          mediaType: input.mediaType,
        });
        if (asset) await upsertAssetWithOptionalScan(ctx, asset, input.asset?.scan);
        return stored;
      },
      ensureBlobRef: async (input) => {
        const ref = await ensureBlobRef(ctx, input);
        if (input.asset) {
          await upsertRegistryAsset(ctx, {
            ...assetForWrite(ctx, input.asset),
            digest: input.digest,
            blobRefId: input.asset.blobRefId ?? ref.blobRefId,
            role: input.asset.role ?? input.kind,
            scope: input.asset.scope ?? input.scope,
            sizeBytes: input.asset.sizeBytes ?? ref.size,
          });
        }
        return ref;
      },
      releaseBlobRef: async (input) => {
        await releaseBlobRef(ctx, input);
        await deleteRegistryAssetRef(ctx, {
          digest: input.digest,
          scope: input.scope,
          role: input.kind,
        });
      },
      staging: {
        putKey: (key, data) => blobStore.putAtKey(key, data),
        putKeyStream: (key, data) => blobStore.putStreamAtKey(key, data),
        readKey: (key) => blobStore.readKey(key),
        bytesAtKey: (key) => blobStore.bytesAtKey(key),
        statKey: (key) => blobStore.statKey(key),
        deleteKey: (key) => blobStore.deleteKey(key),
        presignPutKey: (key, expiresIn) => blobStore.presignPutKey(key, expiresIn),
      },
    },
    assets: {
      upsert: async (input) => {
        const scope = input.scope ?? "";
        const existing = await findRegistryAssetByScope(ctx, { role: input.role, scope });
        if (existing && existing.digest !== input.digest) {
          await releaseBlobRef(ctx, { digest: existing.digest, kind: input.role, scope });
          await deleteRegistryAssetRef(ctx, { digest: existing.digest, scope, role: input.role });
        }
        const asset = assetForWrite(ctx, input);
        const scanInput = input.scanInput;
        if (scanInput && env.SCANNER_ENABLED) {
          return db.transaction(async (tx) => {
            const row = await upsertRegistryAsset(ctx, asset, tx);
            await recordArtifactScanOutbox(
              ctx.repo,
              scanInput,
              () => captureTelemetryContext(),
              tx,
            );
            return row;
          });
        }
        return upsertRegistryAsset(ctx, asset);
      },
      findByScope: (input) => findRegistryAssetByScope(ctx, input),
      list: (input) =>
        listRegistryAssets(ctx, {
          packageId: input?.package ? packageId(ctx, input.package) : undefined,
          packageVersionId: input?.packageVersion?.id,
          digest: input?.digest,
          limit: input?.limit,
          offset: input?.offset,
        }),
    },
    contentStore: {
      createUploadSession: (input) => createContentUploadSession(ctx, input),
      loadUploadSession: (input) => loadContentUploadSession(ctx, input),
      withLockedUploadSession: (input) => withLockedContentUploadSession(ctx, input),
      markUploadSessionAborted: (input) => markContentUploadSessionAborted(ctx, input),
      listMountSources: listContentMountSources,
      listExistingBlobRefDigests: (input) => listExistingContentBlobRefDigests(ctx, input),
      listExistingManifestDigests: (input) =>
        listExistingContentManifestDigests(ctx, {
          packageId: packageId(ctx, input.package),
          digests: input.digests,
        }),
      blobRefExists: (input) => contentBlobRefExists(ctx, input),
      commitManifest: (input) => {
        assertPackageInRepo(ctx, input.package);
        return commitContentManifest(ctx, {
          manifest: input.manifest,
          packageId: input.package.id,
          tags: input.tags,
          blobDigests: input.blobDigests,
        });
      },
      replaceManifestBlobRefs: (input) => {
        assertPackageInRepo(ctx, input.package);
        assertManifestInRepo(ctx, input.manifest);
        return replaceContentManifestBlobRefs(ctx, {
          packageId: input.package.id,
          manifestId: input.manifest.id,
          digests: input.digests,
        });
      },
      listManifestDigestsReferencingBlob: (input) =>
        listContentManifestDigestsReferencingBlob(ctx, {
          packageId: packageId(ctx, input.package),
          digest: input.digest,
        }),
      resolveManifest: (input) =>
        resolveContentManifest(ctx, {
          packageId: packageId(ctx, input.package),
          reference: input.reference,
        }),
      deleteTagsForManifest: (input) => {
        assertPackageInRepo(ctx, input.package);
        assertManifestInRepo(ctx, input.manifest);
        return deleteContentTagsForManifest({
          packageId: input.package.id,
          manifestId: input.manifest.id,
        });
      },
      deleteManifestIfUnassociated: (input) => {
        assertManifestInRepo(ctx, input.manifest);
        return deleteContentManifestIfUnassociated(ctx, {
          manifestId: input.manifest.id,
          digest: input.digest,
        });
      },
      deleteTag: (input) =>
        deleteContentTag({ packageId: packageId(ctx, input.package), tag: input.tag }),
      listLiveManifestsForPackage: (pkg) =>
        listLiveContentManifestsForPackage(ctx, packageId(ctx, pkg)),
      listTags: (pkg, opts) => listContentTags(packageId(ctx, pkg), opts),
      listSubjectManifests: (subjectDigest) => listContentSubjectManifests(ctx, subjectDigest),
    },
  };
}

export { publisherOf };
