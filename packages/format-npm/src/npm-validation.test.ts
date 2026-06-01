import { describe, expect, test } from "bun:test";
import {
  basename,
  isValidDistTag,
  isValidNpmName,
  isValidNpmVersion,
  packagePath,
} from "./npm-validation";

describe("npm validation helpers", () => {
  test("validates package names and builds URL-safe paths", () => {
    expect(isValidNpmName("left-pad")).toBe(true);
    expect(isValidNpmName("@scope/pkg.name")).toBe(true);
    expect(isValidNpmName("BadName")).toBe(false);
    expect(isValidNpmName("@scope/")).toBe(false);
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
});
