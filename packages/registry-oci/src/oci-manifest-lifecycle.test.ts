import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { OCI_MEDIA_TYPES } from "@hootifactory/types";
import { buildOciManifestCreatedHeaders, putOciManifest } from "./oci-manifest-lifecycle";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBJECT_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHILD_DIGEST_A = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CHILD_DIGEST_B = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

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
});
