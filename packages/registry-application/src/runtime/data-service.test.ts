import { describe, expect, test } from "bun:test";
import { replacedAssetRef } from "./data-service";

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
});
