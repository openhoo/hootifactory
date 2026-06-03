import { describe, expect, test } from "bun:test";
import { buildNugetRegistrationIndex, buildNugetRegistrationItem } from "./nuget-registration";

describe("NuGet registration helpers", () => {
  test("builds package registration leaves with normalized URLs and dependency groups", () => {
    expect(
      buildNugetRegistrationItem({
        id: "Hoot.Lib",
        version: "1.2.3",
        base: "https://registry.test/nuget/private",
        metadata: {
          nupkgDigest: "sha256:test",
          file: "hoot.lib.1.2.3.nupkg",
          displayId: "Hoot.Lib",
          dependencyGroups: [
            {
              targetFramework: "net8.0",
              dependencies: [{ id: "Other.Lib", range: "[2.0.0, )" }],
            },
          ],
        },
      }),
    ).toEqual({
      "@id": "https://registry.test/nuget/private/v3/registrations/hoot.lib/1.2.3.json",
      "@type": "Package",
      catalogEntry: {
        "@id": "https://registry.test/nuget/private/v3/registrations/hoot.lib/1.2.3.json",
        "@type": "PackageDetails",
        id: "Hoot.Lib",
        version: "1.2.3",
        listed: true,
        packageContent:
          "https://registry.test/nuget/private/v3-flatcontainer/hoot.lib/1.2.3/hoot.lib.1.2.3.nupkg",
        dependencyGroups: [
          {
            targetFramework: "net8.0",
            dependencies: [
              {
                id: "Other.Lib",
                range: "[2.0.0, )",
                registration:
                  "https://registry.test/nuget/private/v3/registrations/other.lib/index.json",
              },
            ],
          },
        ],
      },
      packageContent:
        "https://registry.test/nuget/private/v3-flatcontainer/hoot.lib/1.2.3/hoot.lib.1.2.3.nupkg",
      registrationLeafUrl:
        "https://registry.test/nuget/private/v3/registrations/hoot.lib/1.2.3.json",
      registration: "https://registry.test/nuget/private/v3/registrations/hoot.lib/index.json",
    });
  });

  test("builds registration index pages with version bounds", () => {
    const index = buildNugetRegistrationIndex({
      id: "Hoot.Lib",
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
            listed: false,
          },
        },
      ],
    });

    expect(index.count).toBe(1);
    expect(index.items[0]).toMatchObject({
      "@id": "https://registry.test/nuget/private/v3/registrations/hoot.lib/index.json",
      count: 2,
      lower: "1.0.0",
      upper: "2.0.0",
    });
    expect(index.items[0]?.items[1]?.catalogEntry).toMatchObject({
      listed: false,
      version: "2.0.0",
    });
  });

  test("builds an empty registration index when no versions are present", () => {
    expect(
      buildNugetRegistrationIndex({
        id: "Hoot.Lib",
        base: "https://registry.test/nuget/private",
        versions: [],
      }),
    ).toEqual({ count: 0, items: [] });
  });
});
