import { describe, expect, test } from "bun:test";
import {
  compareNugetVersions,
  escapeXml,
  isPrereleaseNugetVersion,
  isSemVer2NugetVersion,
  NugetSearchQuerySchema,
  normalizeNugetVersion,
  parseNugetVersionMeta,
} from "./nuget-validation";

describe("NuGet validation helpers", () => {
  test("normalizes package versions to the NuGet server form", () => {
    expect(normalizeNugetVersion(" 01.002 ")).toBe("1.2.0");
    expect(normalizeNugetVersion("1.2.3.0+build.7")).toBe("1.2.3");
    expect(normalizeNugetVersion("1.2.3-BETA.1")).toBe("1.2.3-beta.1");
    expect(normalizeNugetVersion("1.2.3-")).toBeNull();
    expect(normalizeNugetVersion("1.2.3.4.5")).toBeNull();
  });

  test("sorts normalized versions with NuGet prerelease precedence", () => {
    const versions = ["1.0.0", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-alpha", "2.0.0"];

    expect(versions.sort(compareNugetVersions)).toEqual([
      "1.0.0-alpha",
      "1.0.0-beta.2",
      "1.0.0-beta.10",
      "1.0.0",
      "2.0.0",
    ]);
  });

  test("classifies prerelease and SemVer2 package versions", () => {
    expect(isPrereleaseNugetVersion("1.0.0-beta")).toBe(true);
    expect(isPrereleaseNugetVersion("1.0.0")).toBe(false);
    expect(isSemVer2NugetVersion("1.0.0+build.7")).toBe(true);
    expect(isSemVer2NugetVersion("1.0.0-beta.1")).toBe(true);
    expect(isSemVer2NugetVersion("1.0.0-beta")).toBe(false);
  });

  test("escapes XML text used in generated nuspec responses", () => {
    expect(escapeXml(`A&B<"C">`)).toBe("A&amp;B&lt;&quot;C&quot;&gt;");
  });

  test("normalizes search query text, paging bounds, and protocol flags", () => {
    expect(
      NugetSearchQuerySchema.parse({
        q: "  Foo  ",
        skip: "2.9",
        take: "250",
        prerelease: "TRUE",
        semVerLevel: "2.0.0",
      }),
    ).toEqual({
      q: "foo",
      skip: 2,
      take: 100,
      includePrerelease: true,
      includeSemVer2: true,
    });

    expect(
      NugetSearchQuerySchema.parse({
        skip: "-1",
        take: "0",
        prerelease: "false",
        semVerLevel: "1.0.0",
      }),
    ).toEqual({
      q: "",
      skip: 0,
      take: 20,
      includePrerelease: false,
      includeSemVer2: false,
    });
  });

  test("parses stored NuGet version metadata through a strict schema", () => {
    expect(
      parseNugetVersionMeta({
        nupkgDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        file: "hoot.lib.1.2.3.nupkg",
        displayId: "Hoot.Lib",
        listed: false,
        semVer2: true,
        dependencyGroups: [
          {
            targetFramework: "net8.0",
            dependencies: [{ id: "Other.Lib", range: "[2.0.0, )" }],
          },
        ],
      }),
    ).toEqual({
      nupkgDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      file: "hoot.lib.1.2.3.nupkg",
      displayId: "Hoot.Lib",
      listed: false,
      semVer2: true,
      dependencyGroups: [
        {
          targetFramework: "net8.0",
          dependencies: [{ id: "Other.Lib", range: "[2.0.0, )" }],
        },
      ],
    });

    expect(
      parseNugetVersionMeta({
        nupkgDigest: "not-a-digest",
        file: "../bad.nupkg",
      }),
    ).toBeNull();
  });
});
