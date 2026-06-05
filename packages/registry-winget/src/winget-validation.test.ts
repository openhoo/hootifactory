import { describe, expect, test } from "bun:test";
import {
  buildWingetManifestVersion,
  buildWingetPackageManifest,
  buildWingetSearchResult,
  wingetData,
  wingetInstallerUrl,
  wingetMatches,
} from "./winget-documents";
import {
  isValidWingetPackageIdentifier,
  isValidWingetVersion,
  parseWingetVersionMeta,
  WingetPublishManifestSchema,
  WingetSearchRequestSchema,
  type WingetVersionMeta,
  wingetSearchCriteria,
  wingetSearchKeyword,
} from "./winget-validation";

const META: WingetVersionMeta = {
  installerDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  installerSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  architecture: "x64",
  installerType: "exe",
  scope: "machine",
  publisher: "Acme",
  packageName: "Widget",
  shortDescription: "A widget",
  license: "MIT",
  filename: "widget-1.0.0.exe",
};

describe("winget validation", () => {
  test("PackageIdentifier must be Publisher.Package with allowed segment chars", () => {
    expect(isValidWingetPackageIdentifier("Acme.Widget")).toBe(true);
    expect(isValidWingetPackageIdentifier("Microsoft.PowerToys")).toBe(true);
    expect(isValidWingetPackageIdentifier("Acme.Sub.Widget")).toBe(true);
    expect(isValidWingetPackageIdentifier("vendor-x.tool-y")).toBe(true);
    expect(isValidWingetPackageIdentifier("NoDot")).toBe(false);
    expect(isValidWingetPackageIdentifier("Acme.")).toBe(false);
    expect(isValidWingetPackageIdentifier("Acme.Wid get")).toBe(false);
    expect(isValidWingetPackageIdentifier("../etc")).toBe(false);
    expect(isValidWingetPackageIdentifier("Acme.Wid/get")).toBe(false);
  });

  test("versions are bounded URL-safe strings", () => {
    expect(isValidWingetVersion("1.0.0")).toBe(true);
    expect(isValidWingetVersion("2024.03.1-beta")).toBe(true);
    expect(isValidWingetVersion("v1.2.3+build")).toBe(true);
    expect(isValidWingetVersion("bad version")).toBe(false);
    expect(isValidWingetVersion("../1.0")).toBe(false);
    expect(isValidWingetVersion("")).toBe(false);
  });

  test("parseWingetVersionMeta round-trips a valid metadata record", () => {
    expect(parseWingetVersionMeta(META)).toEqual(META);
    expect(parseWingetVersionMeta({ ...META, installerSha256: "lowercasehex" })).toBeNull();
    expect(parseWingetVersionMeta({})).toBeNull();
    expect(parseWingetVersionMeta(null)).toBeNull();
  });

  test("wingetSearchKeyword reads Query.KeyWord then Inclusions", () => {
    const fromQuery = WingetSearchRequestSchema.parse({
      Query: { KeyWord: "widget", MatchType: "Substring" },
    });
    expect(wingetSearchKeyword(fromQuery)).toBe("widget");

    const fromInclusions = WingetSearchRequestSchema.parse({
      Inclusions: [{ PackageMatchField: "PackageName", RequestMatch: { KeyWord: "acme" } }],
    });
    expect(wingetSearchKeyword(fromInclusions)).toBe("acme");

    expect(wingetSearchKeyword(WingetSearchRequestSchema.parse({}))).toBe("");
  });

  test("wingetSearchCriteria surfaces the needle and honors MatchType Exact", () => {
    expect(
      wingetSearchCriteria(
        WingetSearchRequestSchema.parse({ Query: { KeyWord: "widget", MatchType: "Exact" } }),
      ),
    ).toEqual({ needle: "widget", exact: true });

    expect(
      wingetSearchCriteria(
        WingetSearchRequestSchema.parse({ Query: { KeyWord: "widget", MatchType: "Substring" } }),
      ),
    ).toEqual({ needle: "widget", exact: false });

    // A keyword carried in Filters (not just Inclusions) is also picked up.
    expect(
      wingetSearchCriteria(
        WingetSearchRequestSchema.parse({
          Filters: [{ PackageMatchField: "PackageName", RequestMatch: { KeyWord: "acme" } }],
        }),
      ),
    ).toEqual({ needle: "acme", exact: false });

    expect(wingetSearchCriteria(WingetSearchRequestSchema.parse({}))).toEqual({
      needle: "",
      exact: false,
    });
  });

  test("wingetMatches: substring vs exact; empty needle matches all", () => {
    expect(wingetMatches("widget", ["Acme.Widget", "Widget"])).toBe(true);
    expect(wingetMatches("ACME", ["Acme.Widget"])).toBe(true);
    expect(wingetMatches("nope", ["Acme.Widget", "Widget"])).toBe(false);
    expect(wingetMatches("", ["anything"])).toBe(true);
    // Exact mode requires full case-insensitive equality of some haystack.
    expect(wingetMatches("widget", ["Acme.Widget", "Widget"], { exact: true })).toBe(true);
    expect(wingetMatches("wid", ["Acme.Widget", "Widget"], { exact: true })).toBe(false);
    expect(wingetMatches("acme.widget", ["Acme.Widget"], { exact: true })).toBe(true);
  });

  test("publish manifest rejects a Publisher/PackageName with non-segment chars", () => {
    expect(
      WingetPublishManifestSchema.safeParse({
        PackageVersion: "1.0.0",
        Publisher: "Acme",
        PackageName: "Widget",
      }).success,
    ).toBe(true);
    // A dot would make the reconstructed identifier ambiguous; spaces/paths too.
    expect(
      WingetPublishManifestSchema.safeParse({
        PackageVersion: "1.0.0",
        Publisher: "Acme.Corp",
        PackageName: "Widget",
      }).success,
    ).toBe(false);
    expect(
      WingetPublishManifestSchema.safeParse({
        PackageVersion: "1.0.0",
        Publisher: "Acme",
        PackageName: "Wid get",
      }).success,
    ).toBe(false);
  });
});

describe("winget documents", () => {
  const base = { baseUrl: "https://reg.test", mountPath: "winget/private" };

  test("installer URL points at the hosted installers route", () => {
    expect(
      wingetInstallerUrl(base.baseUrl, base.mountPath, "Acme.Widget", "1.0.0", "widget.exe"),
    ).toBe("https://reg.test/winget/private/api/installers/Acme.Widget/1.0.0/widget.exe");
  });

  test("manifest version maps stored metadata to a winget Installers entry", () => {
    const version = buildWingetManifestVersion({
      ...base,
      packageIdentifier: "Acme.Widget",
      version: "1.0.0",
      metadata: META,
    });
    expect(version).toEqual({
      PackageVersion: "1.0.0",
      DefaultLocale: {
        PackageLocale: "en-US",
        Publisher: "Acme",
        PackageName: "Widget",
        ShortDescription: "A widget",
        License: "MIT",
      },
      Installers: [
        {
          Architecture: "x64",
          InstallerType: "exe",
          InstallerUrl:
            "https://reg.test/winget/private/api/installers/Acme.Widget/1.0.0/widget-1.0.0.exe",
          InstallerSha256: META.installerSha256,
          Scope: "machine",
        },
      ],
    });
  });

  test("a full package manifest wraps versions and omits absent optionals", () => {
    const manifest = buildWingetPackageManifest({
      ...base,
      packageIdentifier: "Acme.Widget",
      versions: [
        {
          version: "1.0.0",
          metadata: { ...META, scope: undefined, license: undefined, shortDescription: undefined },
        },
      ],
    });
    const installer = manifest.Versions[0]?.Installers[0];
    expect(manifest.PackageIdentifier).toBe("Acme.Widget");
    expect(installer && "Scope" in installer).toBe(false);
    expect(manifest.Versions[0]?.DefaultLocale.ShortDescription).toBe("");
    expect("License" in (manifest.Versions[0]?.DefaultLocale ?? {})).toBe(false);
  });

  test("search result groups versions newest-style", () => {
    expect(
      buildWingetSearchResult({
        packageIdentifier: "Acme.Widget",
        packageName: "Widget",
        publisher: "Acme",
        versions: ["1.0.0", "1.1.0"],
      }),
    ).toEqual({
      PackageIdentifier: "Acme.Widget",
      PackageName: "Widget",
      Publisher: "Acme",
      Versions: [{ PackageVersion: "1.0.0" }, { PackageVersion: "1.1.0" }],
    });
  });

  test("wingetData wraps any payload in a Data envelope", () => {
    expect(wingetData([1, 2])).toEqual({ Data: [1, 2] });
  });
});
