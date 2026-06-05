import { describe, expect, test } from "bun:test";
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
});
