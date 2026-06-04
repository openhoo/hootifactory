import { describe, expect, test } from "bun:test";
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
