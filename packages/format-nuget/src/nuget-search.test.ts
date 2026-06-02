import { describe, expect, test } from "bun:test";
import {
  buildNugetSearchResponse,
  buildNugetSearchResult,
  filterNugetSearchVersions,
  type NugetSearchVersion,
  parseNugetSearchQuery,
} from "./nuget-search";

describe("NuGet search helpers", () => {
  test("parses NuGet search query defaults and protocol flags", () => {
    expect(parseNugetSearchQuery("https://registry.test/v3/query")).toEqual({
      q: "",
      skip: 0,
      take: 20,
      includePrerelease: false,
      includeSemVer2: false,
    });
    expect(
      parseNugetSearchQuery(
        "https://registry.test/v3/query?q= Hoot &skip=2&take=5&prerelease=true&semVerLevel=2.0.0",
      ),
    ).toEqual({
      q: "hoot",
      skip: 2,
      take: 5,
      includePrerelease: true,
      includeSemVer2: true,
    });
  });

  test("filters prerelease and SemVer2 versions according to query flags", () => {
    const versions: NugetSearchVersion[] = [
      { version: "1.0.0", metadata: { nupkgDigest: "sha256:a", file: "a.nupkg" } },
      { version: "1.1.0-beta.1", metadata: { nupkgDigest: "sha256:b", file: "b.nupkg" } },
      {
        version: "1.2.0",
        metadata: { nupkgDigest: "sha256:c", file: "c.nupkg", semVer2: true },
      },
    ];

    expect(
      filterNugetSearchVersions(versions, {
        q: "",
        skip: 0,
        take: 20,
        includePrerelease: false,
        includeSemVer2: false,
      }).map((version) => version.version),
    ).toEqual(["1.0.0"]);
    expect(
      filterNugetSearchVersions(versions, {
        q: "",
        skip: 0,
        take: 20,
        includePrerelease: true,
        includeSemVer2: true,
      }).map((version) => version.version),
    ).toEqual(["1.0.0", "1.1.0-beta.1", "1.2.0"]);
  });

  test("builds NuGet search result entries from version metadata", () => {
    expect(
      buildNugetSearchResult({
        packageName: "Hoot.Lib",
        base: "https://registry.test/nuget/private",
        versions: [
          {
            version: "1.0.0",
            metadata: { nupkgDigest: "sha256:a", file: "hoot.lib.1.0.0.nupkg" },
          },
          {
            version: "2.0.0",
            metadata: {
              nupkgDigest: "sha256:b",
              file: "hoot.lib.2.0.0.nupkg",
              displayId: "Hoot.Lib",
            },
          },
        ],
      }),
    ).toEqual({
      id: "Hoot.Lib",
      version: "2.0.0",
      versions: [
        {
          version: "1.0.0",
          downloads: 0,
          "@id": "https://registry.test/nuget/private/v3/registrations/hoot.lib/1.0.0.json",
        },
        {
          version: "2.0.0",
          downloads: 0,
          "@id": "https://registry.test/nuget/private/v3/registrations/hoot.lib/2.0.0.json",
        },
      ],
      packageTypes: [],
      registration: "https://registry.test/nuget/private/v3/registrations/hoot.lib/index.json",
      totalDownloads: 0,
    });
  });

  test("paginates search responses while preserving total hits", () => {
    expect(buildNugetSearchResponse(["a", "b", "c"], { skip: 1, take: 1 })).toEqual({
      totalHits: 3,
      data: ["b"],
    });
  });
});
