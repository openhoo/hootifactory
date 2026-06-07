import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { assetWithDefaults, replacedAssetRef } from "./data-service-helpers";

const OLD_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("registry data service asset replacement helpers", () => {
  test("does not delete asset rows when no digest was replaced", () => {
    expect(
      replacedAssetRef({
        currentDigest: NEW_DIGEST,
        kind: "npm_tarball",
        scope: "demo@1.0.0",
      }),
    ).toBeNull();
    expect(
      replacedAssetRef({
        previousDigest: NEW_DIGEST,
        currentDigest: NEW_DIGEST,
        kind: "npm_tarball",
        scope: "demo@1.0.0",
      }),
    ).toBeNull();
  });

  test("targets the previous asset row for blob-backed version replacements", () => {
    expect(
      replacedAssetRef({
        previousDigest: OLD_DIGEST,
        currentDigest: NEW_DIGEST,
        kind: "npm_tarball",
        scope: "demo@1.0.0",
        asset: {
          role: "npm_tarball",
          scope: "demo@1.0.0",
        },
      }),
    ).toEqual({
      digest: OLD_DIGEST,
      role: "npm_tarball",
      scope: "demo@1.0.0",
    });
  });

  test("falls back to the blob kind role and scope when no asset override is provided", () => {
    expect(
      replacedAssetRef({
        previousDigest: OLD_DIGEST,
        currentDigest: NEW_DIGEST,
        kind: "oci_layer",
        scope: "team/api",
      }),
    ).toEqual({
      digest: OLD_DIGEST,
      role: "oci_layer",
      scope: "team/api",
    });
  });

  test("defaults ref-backed asset writes from the stored blob", () => {
    const ctx = createTestRegistryContext();

    expect(
      assetWithDefaults(
        ctx,
        {
          role: "pypi_file",
          path: "hoot_lib-1.2.3.tar.gz",
        },
        {
          digest: NEW_DIGEST,
          size: 42,
          blobRefId: "blob_ref_1",
        },
        {
          scope: "hoot_lib-1.2.3.tar.gz",
          mediaType: "application/octet-stream",
        },
      ),
    ).toEqual({
      role: "pypi_file",
      path: "hoot_lib-1.2.3.tar.gz",
      scope: "hoot_lib-1.2.3.tar.gz",
      digest: NEW_DIGEST,
      blobRefId: "blob_ref_1",
      mediaType: "application/octet-stream",
      sizeBytes: 42,
    });
  });
});

/**
 * createRegistryDataService wires the per-request facade: every method is a thin
 * delegate onto a query/store helper, frequently translating handles into ids
 * via packageId() first. Mock each collaborator module to return a tagged
 * sentinel so the wiring (and the handle-id translation) is asserted without a
 * database. Records the args each delegate received.
 */
async function loadDataService() {
  const calls: Record<string, unknown[]> = {};
  const spy =
    (name: string, ret: unknown = `ret:${name}`) =>
    (...args: unknown[]) => {
      calls[name] = args;
      return ret;
    };

  // Helpers that must keep their real semantics (id translation + assertions).
  const realHelpers = await import("./data-service-helpers");

  await mock.module("../assets", () => ({
    upsertRegistryAsset: spy("upsertRegistryAsset"),
    findRegistryAssetByScope: spy("findRegistryAssetByScope"),
    listRegistryAssets: spy("listRegistryAssets"),
    deleteRegistryAssetRef: spy("deleteRegistryAssetRef"),
  }));
  await mock.module("../content", () => ({
    isArtifactBlocked: spy("isArtifactBlocked"),
    areAllArtifactsBlocked: spy("areAllArtifactsBlocked"),
    serveBlobIfClean: spy("serveBlobIfClean"),
    uploadBlobStream: spy("uploadBlobStream"),
    discardUncommittedBlobPut: spy("discardUncommittedBlobPut"),
    blobRefExists: spy("blobRefExists"),
    getBlobRef: spy("getBlobRef"),
    storeBlobWithRef: spy("storeBlobWithRef", { digest: "sha256:s" }),
    storeBlobStreamWithRef: spy("storeBlobStreamWithRef", { digest: "sha256:s" }),
    ensureBlobRef: spy("ensureBlobRef", { blobRefId: "b", size: 1 }),
    releaseBlobRef: spy("releaseBlobRef"),
  }));
  await mock.module("../packages/queries", () => ({
    findOrCreatePackage: undefined,
    listRepositoryPackageNames: spy("listNames"),
    listRepositoryPackages: spy("list"),
    searchRepositoryPackages: spy("search"),
    packageVersionExists: spy("exists"),
    listPackageVersionNames: spy("listVersionNames"),
    listLivePackageVersions: spy("listLive"),
    listLivePackageVersionsForPackages: spy("listLiveForPackages"),
    listSearchPackageVersionsForPackages: spy("listSearchVersionsForPackages"),
    listLivePackageVersionFingerprints: spy("listLiveFingerprints"),
    listRepositoryVersionMetadata: spy("listRepositoryMetadata"),
    listLivePackageVersionNames: spy("listLiveNames"),
    updatePackageVersionMetadata: spy("updateMetadata"),
    patchPackageVersion: spy("patch"),
    listLiveVersionPublishers: spy("listPublishers"),
    listLiveDistTags: spy("tagsListLive"),
    listLiveDistTagsForPackages: spy("tagsListLiveForPackages"),
    deleteDistTag: spy("deleteDistTag"),
    replaceDistTags: spy("replaceDistTags"),
    updatePackageLatestVersion: spy("updateLatestVersion"),
  }));
  await mock.module("../packages/versions", () => ({
    publisherOf: spy("publisherOf"),
    setDistTag: spy("setDistTag"),
    createPackageVersion: spy("create"),
    upsertPackageVersion: spy("upsert"),
    upsertPackageVersionWithBlobRef: spy("upsertWithBlobRef", {
      versionId: "v1",
      stored: { digest: "sha256:s", size: 1, blobRefId: "b1" },
    }),
    commitVersionOrReleaseBlob: spy("commitOrReleaseBlob", { versionId: "v1" }),
  }));
  await mock.module("../repositories", () => ({
    findLiveVersion: spy("findLive"),
    findOrCreatePackage: spy("findOrCreate"),
    findPackageByName: spy("findByName"),
    findVersion: spy("find"),
  }));
  await mock.module("../content/manifest-store", () => ({
    commitContentManifest: spy("commitManifest"),
    contentBlobRefExists: spy("contentBlobRefExists"),
    deleteContentManifestIfUnassociated: spy("deleteManifestIfUnassociated"),
    deleteContentTag: spy("deleteTag"),
    deleteContentTagsForManifest: spy("deleteTagsForManifest"),
    listContentManifestDigestsReferencingBlob: spy("listManifestDigestsReferencingBlob"),
    listContentSubjectManifests: spy("listSubjectManifests"),
    listContentTags: spy("listTags"),
    listExistingContentBlobRefDigests: spy("listExistingBlobRefDigests"),
    listExistingContentManifestDigests: spy("listExistingManifestDigests"),
    listLiveContentManifestsForPackage: spy("listLiveManifestsForPackage"),
    markContentPackageVersionsDeletedByDigest: spy("markPackageVersionsDeletedByDigest"),
    replaceContentManifestBlobRefs: spy("replaceManifestBlobRefs"),
    resolveContentManifest: spy("resolveManifest"),
  }));
  await mock.module("../content/upload-sessions", () => ({
    createContentUploadSession: spy("createUploadSession"),
    listContentMountSources: spy("listMountSources"),
    loadContentUploadSession: spy("loadUploadSession"),
    markContentUploadSessionAborted: spy("markUploadSessionAborted"),
    withLockedContentUploadSession: spy("withLockedUploadSession"),
  }));

  const { createRegistryDataService } = await import("./data-service");
  return { createRegistryDataService, calls, realHelpers };
}

describe("createRegistryDataService wiring", () => {
  afterEach(() => mock.restore());

  test("package + version + tag reads delegate to the query helpers", async () => {
    const { createRegistryDataService, calls } = await loadDataService();
    const ctx = createTestRegistryContext();
    const data = createRegistryDataService(ctx);
    const pkg = { id: "pkg_1", orgId: ctx.repo.orgId, repositoryId: ctx.repo.id };
    const p = pkg as any;

    expect(data.packages.findByName("demo")).toBe("ret:findByName");
    data.packages.findOrCreate({ name: "demo" });
    expect(data.packages.listNames()).toBe("ret:listNames");
    expect(data.packages.list()).toBe("ret:list");
    expect(data.packages.search({ text: "a", from: 0, size: 1 })).toBe("ret:search");

    expect(data.versions.find(p, "1.0.0")).toBe("ret:find");
    expect(data.versions.findLive(p, "1.0.0")).toBe("ret:findLive");
    expect(data.versions.exists(p, "1.0.0")).toBe("ret:exists");
    expect(data.versions.listLive(p, {})).toBe("ret:listLive");
    expect(data.tags.listLive(p)).toBe("ret:tagsListLive");
    expect(data.tags.delete(p, "beta")).toBe("ret:deleteDistTag");

    // packageId() translation hands the helper the bare id, not the handle.
    expect(calls.find).toEqual(["pkg_1", "1.0.0"]);
  });

  test("tag set + replace assert the version belongs to the package", async () => {
    const { createRegistryDataService, calls } = await loadDataService();
    const ctx = createTestRegistryContext();
    const data = createRegistryDataService(ctx);
    const pkg = { id: "pkg_1", orgId: ctx.repo.orgId, repositoryId: ctx.repo.id };
    const version = { id: "v1", packageId: "pkg_1", version: "1.0.0" };
    data.tags.set(pkg as any, "latest", version as any);
    expect(calls.setDistTag).toEqual(["pkg_1", "latest", "v1"]);
    data.tags.replace(pkg as any, new Map([["latest", version as any]]));
    expect(calls.replaceDistTags?.[0]).toBe("pkg_1");

    // A version handle from another package is rejected.
    const foreign = { id: "v2", packageId: "other", version: "2.0.0" };
    expect(() => data.tags.set(pkg as any, "latest", foreign as any)).toThrow();
  });

  test("content + contentStore methods delegate after enforcing repo ownership", async () => {
    const { createRegistryDataService, calls } = await loadDataService();
    const ctx = createTestRegistryContext();
    const data = createRegistryDataService(ctx);
    const pkg = { id: "pkg_1", orgId: ctx.repo.orgId, repositoryId: ctx.repo.id };
    const p = pkg as any;

    expect(data.content.isArtifactBlocked("sha256:x")).toBe("ret:isArtifactBlocked");
    expect(data.content.blobRefExists({ digest: "sha256:x", kind: "k", scope: "s" })).toBe(
      "ret:blobRefExists",
    );
    expect(data.contentStore.listTags(p, {})).toBe("ret:listTags");
    expect(data.contentStore.resolveManifest({ package: p, reference: "latest" })).toBe(
      "ret:resolveManifest",
    );
    expect(calls.listTags?.[0]).toBe("pkg_1");
    expect(data.contentStore.listMountSources("sha256:x")).toBe("ret:listMountSources");
  });

  test("blob-backed version writes store the blob then upsert the derived asset", async () => {
    const { createRegistryDataService, calls } = await loadDataService();
    const ctx = createTestRegistryContext();
    const data = createRegistryDataService(ctx);
    const pkg = { id: "pkg_1", orgId: ctx.repo.orgId, repositoryId: ctx.repo.id };

    const result = await data.versions.upsertWithBlobRef({
      package: pkg as any,
      version: "1.0.0",
      metadata: {},
      sizeBytes: 1,
      blob: {
        data: new Uint8Array([1]),
        kind: "npm_tarball",
        scope: "demo@1.0.0",
        asset: { role: "npm_tarball", scope: "demo@1.0.0" },
      },
    });
    expect(result).toMatchObject({ versionId: "v1" });
    // The blob write ran and the derived asset was upserted afterward.
    expect(calls.upsertWithBlobRef).toBeDefined();
    expect(calls.upsertRegistryAsset).toBeDefined();

    const committed = await data.versions.commitOrReleaseBlob({
      package: pkg as any,
      version: "1.0.0",
      metadata: {},
      sizeBytes: 1,
      kind: "npm_tarball",
      scope: "demo@1.0.0",
      stored: { digest: "sha256:s", size: 1, deduped: false, refCreated: true, blobRefId: "b1" },
      scan: {},
    });
    expect(committed).toMatchObject({ versionId: "v1" });
  });

  test("content blob writes derive + upsert the asset, and release deletes its ref", async () => {
    const { createRegistryDataService, calls } = await loadDataService();
    const ctx = createTestRegistryContext();
    const data = createRegistryDataService(ctx);

    await data.content.storeBlobWithRef({
      data: new Uint8Array([1]),
      kind: "npm_tarball",
      scope: "demo@1.0.0",
    });
    expect(calls.storeBlobWithRef).toBeDefined();

    await data.content.ensureBlobRef({
      digest: "sha256:s",
      kind: "npm_tarball",
      scope: "demo@1.0.0",
      asset: { role: "npm_tarball", scope: "demo@1.0.0" },
    });
    expect(calls.ensureBlobRef).toBeDefined();

    await data.content.releaseBlobRef({
      digest: "sha256:s",
      kind: "npm_tarball",
      scope: "demo@1.0.0",
    });
    expect(calls.releaseBlobRef).toBeDefined();
    expect(calls.deleteRegistryAssetRef).toBeDefined();
  });
});
