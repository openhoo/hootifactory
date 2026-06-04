import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import {
  buildOciManifestCreatedHeaders,
  isOciBlobBlocked,
  putOciManifest,
} from "./oci-manifest-lifecycle";

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
        oci: {
          ...base.data.oci,
          listExistingManifestDigests: (input) => {
            batchedInputs.push({ packageId: input.package.id, digests: input.digests });
            return Promise.resolve(input.digests);
          },
          resolveManifest: () => {
            resolveCalls += 1;
            return Promise.resolve(null);
          },
          upsertManifest: (input) =>
            Promise.resolve({ id: "manifest_1", repositoryId: base.repo.id, digest: input.digest }),
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
        oci: {
          ...base.data.oci,
          listExistingBlobRefDigests: (input) => Promise.resolve(input.digests),
          upsertManifest: (input) =>
            Promise.resolve({ id: "manifest_1", repositoryId: base.repo.id, digest: input.digest }),
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
        oci: {
          ...base.data.oci,
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
});
