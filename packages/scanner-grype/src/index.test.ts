import { describe, expect, test } from "bun:test";
import { resolveTestScanner } from "@hootifactory/scanner/testing";
import { grypeScanner, parseGrypeMatches } from "./index";

describe("grype scanner", () => {
  test("maps Grype JSON matches to normalized findings", () => {
    const findings = parseGrypeMatches(
      JSON.stringify({
        matches: [
          {
            vulnerability: { id: "CVE-2026-1000", severity: "High", fix: { versions: ["1.2.0"] } },
            artifact: { name: "lodash", version: "1.0.0", purl: "pkg:npm/lodash@1.0.0" },
          },
        ],
      }),
    );
    expect(findings).toEqual([
      {
        type: "vuln",
        vulnId: "CVE-2026-1000",
        severity: "high",
        packageName: "lodash",
        packageVersion: "1.0.0",
        purl: "pkg:npm/lodash@1.0.0",
        fixedVersion: "1.2.0",
      },
    ]);
  });

  test("tolerates missing fields and JSON without matches", () => {
    expect(parseGrypeMatches(JSON.stringify({ matches: [{}] }))).toEqual([
      {
        type: "vuln",
        vulnId: undefined,
        severity: "unknown",
        packageName: undefined,
        packageVersion: undefined,
        purl: undefined,
        fixedVersion: undefined,
      },
    ]);
    expect(parseGrypeMatches(JSON.stringify({}))).toEqual([]);
  });

  test("throws on non-JSON scanner output", () => {
    expect(() => parseGrypeMatches("not json")).toThrow();
  });

  test("declares a digest-pinned default image and a content-input scanner", () => {
    expect(grypeScanner.capabilities.inputKind).toBe("content");
    const config = grypeScanner.configFromEnv({
      env: {},
      runtime: { cliRuntime: "host" },
      isProduction: true,
    });
    expect(config.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  test("rejects an unpinned image under the production Docker runtime", () => {
    expect(() =>
      grypeScanner.configFromEnv({
        env: { GRYPE_IMAGE: "anchore/grype:latest" },
        runtime: { cliRuntime: "docker" },
        isProduction: true,
      }),
    ).toThrow(/GRYPE_IMAGE must be pinned/);
    // The same unpinned image is allowed on the host runtime / outside production.
    expect(
      grypeScanner.configFromEnv({
        env: { GRYPE_IMAGE: "anchore/grype:latest" },
        runtime: { cliRuntime: "host" },
        isProduction: true,
      }).image,
    ).toBe("anchore/grype:latest");
  });

  test("is unavailable on the disabled runtime", () => {
    const resolved = resolveTestScanner(grypeScanner, { runtime: { cliRuntime: "disabled" } });
    expect(resolved.available).toBe(false);
  });
});
