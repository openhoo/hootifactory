import { describe, expect, test } from "bun:test";
import type { RegistryManifestRow, RegistryPackageRow } from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import {
  buildOciManifestCreatedHeaders,
  deleteOciBlobReference,
  deleteOciManifestReference,
  isOciBlobBlocked,
  putOciManifest,
  resolveOciManifestForImage,
} from "./oci-manifest-lifecycle";
import { OCI_MEDIA_TYPES } from "./oci-media-types";

function testPackage(): RegistryPackageRow {
  return {
    id: "pkg_1",
    orgId: "org_1",
    repositoryId: "repo_1",
    name: "team/api",
    namespace: null,
    metadata: {},
    latestVersion: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function manifestRow(raw: string): RegistryManifestRow {
  return {
    id: "manifest_1",
    repositoryId: "repo_1",
    digest: DIGEST,
    mediaType: OCI_MEDIA_TYPES.manifestV1,
    artifactType: null,
    subjectDigest: null,
    raw,
    sizeBytes: raw.length,
    configDigest: CONFIG_DIGEST,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBJECT_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHILD_DIGEST_A = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CHILD_DIGEST_B = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const CONFIG_DIGEST = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const LAYER_DIGEST = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("OCI manifest lifecycle helpers", () => {
  test("builds Docker-compatible manifest-created headers for tag pushes", () => {
    expect(
      buildOciManifestCreatedHeaders({
        baseUrl: "https://registry.test",
        mountPath: "v2/acme/containers",
        image: "team/api",
        digest: DIGEST,
        subjectDigest: null,
        acceptedTags: ["latest"],
        referenceKind: "tag",
      }),
    ).toEqual({
      location: `https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`,
      "docker-content-digest": DIGEST,
    });
  });

  test("preserves OCI subject and query tags for digest pushes", () => {
    expect(
      buildOciManifestCreatedHeaders({
        baseUrl: "https://registry.test",
        mountPath: "v2/acme/containers",
        image: "team/api",
        digest: DIGEST,
        subjectDigest: SUBJECT_DIGEST,
        acceptedTags: ["latest", "beta"],
        referenceKind: "digest",
      }),
    ).toEqual({
      location: `https://registry.test/v2/acme/containers/team/api/manifests/${DIGEST}`,
      "docker-content-digest": DIGEST,
      "oci-subject": SUBJECT_DIGEST,
      "oci-tag": "latest, beta",
    });
  });

  test("checks referenced child manifests in one batched lookup", async () => {
    const base = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: base.repo.orgId,
      repositoryId: base.repo.id,
      name: "team/api",
      namespace: null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const batchedInputs: { packageId: string; digests: string[] }[] = [];
    let resolveCalls = 0;
    const ctx = createTestRegistryContext({
      ...base,
      data: {
        ...base.data,
        packages: {
          ...base.data.packages,
          findOrCreate: () => Promise.resolve(pkg),
        },
        versions: {
          ...base.data.versions,
          upsert: () => Promise.resolve("version_1"),
        },
        assets: {
          ...base.data.assets,
          upsert: () => Promise.resolve({} as never),
        },
        contentStore: {
          ...base.data.contentStore,
          listExistingManifestDigests: (input) => {
            batchedInputs.push({ packageId: input.package.id, digests: input.digests });
            return Promise.resolve(input.digests);
          },
          resolveManifest: () => {
            resolveCalls += 1;
            return Promise.resolve(null);
          },
          commitManifest: (input) =>
            Promise.resolve({
              id: "manifest_1",
              repositoryId: base.repo.id,
              digest: input.manifest.digest,
            }),
        },
      },
    });
    const raw = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.imageIndexV1,
      manifests: [
        { mediaType: OCI_MEDIA_TYPES.manifestV1, digest: CHILD_DIGEST_A, size: 1 },
        { mediaType: OCI_MEDIA_TYPES.manifestV1, digest: CHILD_DIGEST_B, size: 1 },
      ],
    });

    await putOciManifest(
      "team/api",
      "latest",
      new Request("https://registry.test/v2/team/api/manifests/latest", {
        method: "PUT",
        headers: { "content-type": OCI_MEDIA_TYPES.imageIndexV1 },
        body: raw,
      }),
      ctx,
    );

    expect(batchedInputs).toEqual([
      { packageId: pkg.id, digests: [CHILD_DIGEST_A, CHILD_DIGEST_B] },
    ]);
    expect(resolveCalls).toBe(0);
  });

  test("records manifest blob references after manifest upsert", async () => {
    const base = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: base.repo.orgId,
      repositoryId: base.repo.id,
      name: "team/api",
      namespace: null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const recordedRefs: string[][] = [];
    const ctx = createTestRegistryContext({
      ...base,
      data: {
        ...base.data,
        packages: {
          ...base.data.packages,
          findOrCreate: () => Promise.resolve(pkg),
        },
        versions: {
          ...base.data.versions,
          upsert: () => Promise.resolve("version_1"),
        },
        assets: {
          ...base.data.assets,
          upsert: () => Promise.resolve({} as never),
        },
        contentStore: {
          ...base.data.contentStore,
          listExistingBlobRefDigests: (input) => Promise.resolve(input.digests),
          commitManifest: (input) =>
            Promise.resolve({
              id: "manifest_1",
              repositoryId: base.repo.id,
              digest: input.manifest.digest,
            }),
          replaceManifestBlobRefs: (input) => {
            recordedRefs.push(input.digests);
            return Promise.resolve();
          },
        },
      },
    });
    const raw = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: CONFIG_DIGEST, size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: LAYER_DIGEST, size: 10 }],
    });

    await putOciManifest(
      "team/api",
      "latest",
      new Request("https://registry.test/v2/team/api/manifests/latest", {
        method: "PUT",
        headers: { "content-type": OCI_MEDIA_TYPES.manifestV1 },
        body: raw,
      }),
      ctx,
    );

    expect(recordedRefs).toEqual([[CONFIG_DIGEST, LAYER_DIGEST]]);
  });

  test("checks blob blocking through indexed manifest references", async () => {
    const base = createTestRegistryContext();
    const pkg = {
      id: "pkg_1",
      orgId: base.repo.orgId,
      repositoryId: base.repo.id,
      name: "team/api",
      namespace: null,
      metadata: {},
      latestVersion: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let packageLookups = 0;
    let referenceLookups = 0;
    let batchedBlockChecks = 0;
    const ctx = createTestRegistryContext({
      ...base,
      data: {
        ...base.data,
        packages: {
          ...base.data.packages,
          findByName: (name) => {
            packageLookups += 1;
            expect(name).toBe(pkg.name);
            return Promise.resolve(pkg);
          },
        },
        content: {
          ...base.data.content,
          isArtifactBlocked: () => {
            throw new Error("blob blocking should use batched manifest state checks");
          },
          areAllArtifactsBlocked: (digests) => {
            batchedBlockChecks += 1;
            expect(digests).toEqual([CHILD_DIGEST_A, CHILD_DIGEST_B]);
            return Promise.resolve(true);
          },
        },
        contentStore: {
          ...base.data.contentStore,
          listManifestDigestsReferencingBlob: (input) => {
            referenceLookups += 1;
            expect(input.package.id).toBe(pkg.id);
            expect(input.digest).toBe(LAYER_DIGEST);
            return Promise.resolve([CHILD_DIGEST_A, CHILD_DIGEST_B]);
          },
        },
      },
    });

    await expect(isOciBlobBlocked(ctx, { image: pkg.name, digest: LAYER_DIGEST })).resolves.toBe(
      true,
    );
    expect(packageLookups).toBe(1);
    expect(referenceLookups).toBe(1);
    expect(batchedBlockChecks).toBe(1);
  });

  test("isOciBlobBlocked returns false for an unknown package", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.contentStore.listManifestDigestsReferencingBlob = async () => {
      throw new Error("should not look up references for an unknown package");
    };

    await expect(isOciBlobBlocked(ctx, { image: "team/api", digest: LAYER_DIGEST })).resolves.toBe(
      false,
    );
  });
});

describe("resolveOciManifestForImage", () => {
  test("returns null when the package does not exist", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;
    ctx.data.contentStore.resolveManifest = async () => {
      throw new Error("resolveManifest should not run without a package");
    };

    await expect(resolveOciManifestForImage(ctx, "team/api", "latest")).resolves.toBeNull();
  });

  test("resolves through the package-scoped manifest lookup", async () => {
    const ctx = createTestRegistryContext();
    const pkg = testPackage();
    const row = manifestRow(JSON.stringify({ schemaVersion: 2 }));
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.contentStore.resolveManifest = async (input) => {
      expect(input.package.id).toBe(pkg.id);
      expect(input.reference).toBe("latest");
      return row;
    };

    await expect(resolveOciManifestForImage(ctx, "team/api", "latest")).resolves.toBe(row);
  });
});

describe("deleteOciManifestReference", () => {
  test("deletes a digest reference and releases now-unused layer blobs", async () => {
    const ctx = createTestRegistryContext();
    const pkg = testPackage();
    const raw = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: CONFIG_DIGEST, size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: LAYER_DIGEST, size: 9 }],
    });
    const order: string[] = [];
    const released: string[] = [];
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.contentStore.resolveManifest = async () => manifestRow(raw);
    ctx.data.contentStore.deleteTagsForManifest = async () => {
      order.push("deleteTags");
    };
    ctx.data.versions.markPackageVersionsDeletedByDigest = async () => {
      order.push("markVersionsDeleted");
      return 1;
    };
    ctx.data.contentStore.deleteManifestIfUnassociated = async () => {
      order.push("deleteManifest");
      return true;
    };
    // No other live manifest references the config/layer, so both blobs are released.
    ctx.data.contentStore.listLiveManifestsForPackage = async () => [];
    ctx.data.content.releaseBlobRef = async ({ digest }) => {
      released.push(digest);
    };

    await deleteOciManifestReference(ctx, { image: "team/api", reference: DIGEST });

    expect(order).toEqual(["deleteTags", "markVersionsDeleted", "deleteManifest"]);
    expect(released.sort()).toEqual([CONFIG_DIGEST, LAYER_DIGEST].sort());
  });

  test("keeps blobs that are still referenced by another live manifest", async () => {
    const ctx = createTestRegistryContext();
    const pkg = testPackage();
    const raw = JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MEDIA_TYPES.manifestV1,
      config: { mediaType: OCI_MEDIA_TYPES.configV1, digest: CONFIG_DIGEST, size: 2 },
      layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: LAYER_DIGEST, size: 9 }],
    });
    const released: string[] = [];
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.contentStore.resolveManifest = async () => manifestRow(raw);
    ctx.data.contentStore.deleteTagsForManifest = async () => {};
    ctx.data.versions.markPackageVersionsDeletedByDigest = async () => 0;
    ctx.data.contentStore.deleteManifestIfUnassociated = async () => true;
    // Another live manifest still uses the layer (but not the config).
    ctx.data.contentStore.listLiveManifestsForPackage = async () => [
      {
        digest: SUBJECT_DIGEST,
        raw: JSON.stringify({
          schemaVersion: 2,
          layers: [{ mediaType: OCI_MEDIA_TYPES.layerTarGzip, digest: LAYER_DIGEST, size: 9 }],
        }),
      },
    ];
    ctx.data.content.releaseBlobRef = async ({ digest }) => {
      released.push(digest);
    };

    await deleteOciManifestReference(ctx, { image: "team/api", reference: DIGEST });

    expect(released).toEqual([CONFIG_DIGEST]);
  });

  test("deletes a tag reference without touching blobs", async () => {
    const ctx = createTestRegistryContext();
    const pkg = testPackage();
    let deletedTag = "";
    ctx.data.packages.findByName = async () => pkg;
    ctx.data.contentStore.resolveManifest = async () => {
      throw new Error("tag deletes should not resolve a manifest");
    };
    ctx.data.contentStore.deleteTag = async ({ tag }) => {
      deletedTag = tag;
      return true;
    };

    await deleteOciManifestReference(ctx, { image: "team/api", reference: "latest" });

    expect(deletedTag).toBe("latest");
  });

  test("throws when a tag delete finds nothing", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => testPackage();
    ctx.data.contentStore.deleteTag = async () => false;

    await expect(
      deleteOciManifestReference(ctx, { image: "team/api", reference: "latest" }),
    ).rejects.toMatchObject({ code: "MANIFEST_UNKNOWN" });
  });

  test("throws when the image package is unknown", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => null;

    await expect(
      deleteOciManifestReference(ctx, { image: "team/api", reference: "latest" }),
    ).rejects.toMatchObject({ code: "MANIFEST_UNKNOWN" });
  });

  test("throws when a digest reference does not resolve to a manifest", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.packages.findByName = async () => testPackage();
    ctx.data.contentStore.resolveManifest = async () => null;

    await expect(
      deleteOciManifestReference(ctx, { image: "team/api", reference: DIGEST }),
    ).rejects.toMatchObject({ code: "MANIFEST_UNKNOWN" });
  });
});

describe("deleteOciBlobReference", () => {
  test("releases an existing blob reference", async () => {
    const ctx = createTestRegistryContext();
    let releasedDigest = "";
    let releasedScope = "";
    ctx.data.contentStore.blobRefExists = async ({ scope, digest }) => {
      expect(scope).toBe("team/api");
      expect(digest).toBe(LAYER_DIGEST);
      return true;
    };
    ctx.data.content.releaseBlobRef = async ({ digest, scope }) => {
      releasedDigest = digest;
      releasedScope = scope;
    };

    await deleteOciBlobReference(ctx, { image: "team/api", digest: LAYER_DIGEST });

    expect(releasedDigest).toBe(LAYER_DIGEST);
    expect(releasedScope).toBe("team/api");
  });

  test("throws when the blob reference is missing", async () => {
    const ctx = createTestRegistryContext();
    ctx.data.contentStore.blobRefExists = async () => false;
    ctx.data.content.releaseBlobRef = async () => {
      throw new Error("missing blobs should never be released");
    };

    await expect(
      deleteOciBlobReference(ctx, { image: "team/api", digest: LAYER_DIGEST }),
    ).rejects.toMatchObject({ code: "BLOB_UNKNOWN" });
  });
});
