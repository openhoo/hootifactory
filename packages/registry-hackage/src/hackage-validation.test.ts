import { describe, expect, test } from "bun:test";
import {
  isValidHackageName,
  isValidHackageVersion,
  parseCabal,
  splitPackageId,
} from "./hackage-validation";

describe("Hackage name/version validation", () => {
  test("accepts dash-separated alphanumeric names with a letter per component", () => {
    expect(isValidHackageName("aeson")).toBe(true);
    expect(isValidHackageName("text-show")).toBe(true);
    expect(isValidHackageName("base64-bytestring")).toBe(true);
    expect(isValidHackageName("HTTP")).toBe(true);
  });

  test("rejects names with a purely-numeric component or bad characters", () => {
    expect(isValidHackageName("foo-1")).toBe(false);
    expect(isValidHackageName("foo_bar")).toBe(false);
    expect(isValidHackageName("foo--bar")).toBe(false);
    expect(isValidHackageName("foo.bar")).toBe(false);
    expect(isValidHackageName("")).toBe(false);
  });

  test("accepts dotted numeric PVP versions", () => {
    expect(isValidHackageVersion("1")).toBe(true);
    expect(isValidHackageVersion("1.2.3")).toBe(true);
    expect(isValidHackageVersion("0.1.0.0")).toBe(true);
  });

  test("rejects non-numeric or malformed versions", () => {
    expect(isValidHackageVersion("1.2.x")).toBe(false);
    expect(isValidHackageVersion("1..2")).toBe(false);
    expect(isValidHackageVersion("v1.0")).toBe(false);
    expect(isValidHackageVersion("01.2")).toBe(false);
  });
});

describe("splitPackageId", () => {
  test("splits a name+version id at the version boundary", () => {
    expect(splitPackageId("aeson-1.5.6.0")).toEqual({ name: "aeson", version: "1.5.6.0" });
    expect(splitPackageId("base64-bytestring-1.2")).toEqual({
      name: "base64-bytestring",
      version: "1.2",
    });
  });

  test("returns null for a bare name (no version suffix)", () => {
    expect(splitPackageId("aeson")).toBeNull();
    expect(splitPackageId("text-show")).toBeNull();
  });
});

describe("parseCabal", () => {
  test("parses name, version, and deduped sorted build-depends", () => {
    const cabal = [
      "name:           my-lib",
      "version:        1.2.3",
      "synopsis:       A demo library",
      "license:        BSD-3-Clause",
      "author:         Jane Doe",
      "homepage:       https://example.test",
      "",
      "library",
      "  build-depends: base >=4.7 && <5,",
      "                 bytestring,",
      "                 text >= 1.0",
      "",
      "executable demo",
      "  build-depends: base, my-lib",
    ].join("\n");
    expect(parseCabal(cabal)).toEqual({
      name: "my-lib",
      version: "1.2.3",
      synopsis: "A demo library",
      license: "BSD-3-Clause",
      author: "Jane Doe",
      homepage: "https://example.test",
      buildDepends: ["base", "bytestring", "my-lib", "text"],
    });
  });

  test("returns null when name or version is missing", () => {
    expect(parseCabal("name: foo")).toBeNull();
    expect(parseCabal("version: 1.0")).toBeNull();
  });

  test("ignores comments and is case-insensitive on field names", () => {
    const cabal = ["Name: Foo -- the package name", "Version: 2.0  -- semver", ""].join("\n");
    expect(parseCabal(cabal)).toEqual({ name: "Foo", version: "2.0", buildDepends: [] });
  });
});
