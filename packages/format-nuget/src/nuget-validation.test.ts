import { describe, expect, test } from "bun:test";
import {
  compareNugetVersions,
  escapeXml,
  isPrereleaseNugetVersion,
  isSemVer2NugetVersion,
  normalizeNugetVersion,
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
});
