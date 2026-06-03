import { describe, expect, test } from "bun:test";
import {
  basename,
  isValidDistTag,
  isValidLegacyNpmName,
  isValidNpmName,
  isValidNpmVersion,
  packagePath,
  parseNpmStoredVersionMetadata,
} from "./npm-validation";

describe("npm validation helpers", () => {
  test("validates package names and builds URL-safe paths", () => {
    expect(isValidNpmName("left-pad")).toBe(true);
    expect(isValidNpmName("@scope/pkg.name")).toBe(true);
    expect(isValidNpmName("BadName")).toBe(false);
    expect(isValidLegacyNpmName("BadName")).toBe(true);
    expect(isValidLegacyNpmName("JSONStream")).toBe(true);
    expect(isValidLegacyNpmName("@Scope/LegacyPkg")).toBe(true);
    expect(isValidNpmName("@scope/")).toBe(false);
    expect(isValidLegacyNpmName("@scope/")).toBe(false);
    expect(packagePath("@scope/pkg")).toBe("%40scope%2Fpkg");
    expect(basename("@scope/pkg")).toBe("pkg");
  });

  test("validates semver versions and rejects malformed numeric prerelease identifiers", () => {
    expect(isValidNpmVersion("1.2.3")).toBe(true);
    expect(isValidNpmVersion("1.2.3-beta.1+build.5")).toBe(true);
    expect(isValidNpmVersion("01.2.3")).toBe(false);
    expect(isValidNpmVersion("1.2.3-beta.01")).toBe(false);
  });

  test("dist-tags cannot masquerade as semver versions", () => {
    expect(isValidDistTag("latest")).toBe(true);
    expect(isValidDistTag("next-1")).toBe(true);
    expect(isValidDistTag("1.0.0")).toBe(false);
    expect(isValidDistTag("v1")).toBe(false);
    expect(isValidDistTag("_bad")).toBe(false);
  });

  test("parses stored npm version metadata through a strict dist schema", () => {
    expect(
      parseNpmStoredVersionMetadata({
        manifest: { name: "pkg", version: "1.0.0" },
        dist: {
          filename: "pkg-1.0.0.tgz",
          blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          shasum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          integrity: "sha512-deadbeef",
          size: 123,
        },
      }),
    ).toEqual({
      manifest: { name: "pkg", version: "1.0.0" },
      dist: {
        filename: "pkg-1.0.0.tgz",
        blobDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shasum: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        integrity: "sha512-deadbeef",
        size: 123,
      },
    });

    expect(
      parseNpmStoredVersionMetadata({
        manifest: "not a manifest",
        dist: {
          filename: "../pkg.tgz",
          blobDigest: "not-a-digest",
          shasum: "not-a-sha1",
          integrity: "",
          size: -1,
        },
      }),
    ).toEqual({ manifest: {} });
  });
});
