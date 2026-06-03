import { describe, expect, test } from "bun:test";
import { buildNugetPublishedMetadata } from "./nuget-publish-lifecycle";

describe("NuGet publish lifecycle helpers", () => {
  test("stores the nupkg digest without dropping parsed metadata", () => {
    expect(
      buildNugetPublishedMetadata(
        {
          metadata: {
            file: "hoot.lib.1.2.3.nupkg",
            displayId: "Hoot.Lib",
            listed: true,
            semVer2: false,
            dependencyGroups: [{ targetFramework: "net8.0", dependencies: [] }],
          },
        },
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual({
      file: "hoot.lib.1.2.3.nupkg",
      displayId: "Hoot.Lib",
      listed: true,
      semVer2: false,
      dependencyGroups: [{ targetFramework: "net8.0", dependencies: [] }],
      nupkgDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});
