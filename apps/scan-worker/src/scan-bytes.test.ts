import { describe, expect, test } from "bun:test";
import type { FindingType, ResolvedScanner, ScannerFailure } from "@hootifactory/scanner";
import { GATING_FINDING_TYPES, uncoveredGatingFindingTypes } from "./scan-bytes";

function contentScanner(id: string, findingTypes: FindingType[]): ResolvedScanner {
  return {
    plugin: {
      id,
      displayName: id,
      capabilities: { inputKind: "content", findingTypes: new Set(findingTypes), network: false },
      configFromEnv: () => null,
      available: () => true,
      scanContent: () => Promise.resolve([]),
    },
    config: null,
    available: true,
  };
}

function failure(id: string): ScannerFailure {
  return { scanner: id, error: new Error(`${id} exploded`) };
}

const clamav = contentScanner("clamav", ["malware"]);
const grype = contentScanner("grype", ["vuln"]);
const trivy = contentScanner("trivy", ["vuln"]);

describe("uncoveredGatingFindingTypes", () => {
  test("ClamAV error + Grype success drops the malware gate → reported uncovered", () => {
    // Regression for #214: a malware scanner erroring while a vuln scanner succeeds
    // must NOT mark the artifact clean. The sole `malware` source failed and no
    // surviving scanner covers `malware`, so the gate would flip fail-open.
    const uncovered = uncoveredGatingFindingTypes([clamav, grype], [failure("clamav")]);
    expect(uncovered).toEqual(["malware"]);
  });

  test("ClamAV error with no surviving sibling is still uncovered", () => {
    expect(uncoveredGatingFindingTypes([clamav], [failure("clamav")])).toEqual(["malware"]);
  });

  test("no errors → nothing uncovered (clean partial result allowed)", () => {
    expect(uncoveredGatingFindingTypes([clamav, grype], [])).toEqual([]);
  });

  test("only a vuln scanner failed → gating malware coverage intact", () => {
    // Grype failing while ClamAV succeeds drops only `vuln`, which is not a gating
    // type, so the malware gate remains covered and the scan may proceed.
    expect(uncoveredGatingFindingTypes([clamav, grype], [failure("grype")])).toEqual([]);
  });

  test("a redundant malware scanner failing is covered by a surviving one", () => {
    const clamavRest = contentScanner("clamav-rest", ["malware"]);
    expect(uncoveredGatingFindingTypes([clamav, clamavRest, grype], [failure("clamav")])).toEqual(
      [],
    );
  });

  test("both ClamAV and a vuln scanner fail → malware still uncovered", () => {
    expect(
      uncoveredGatingFindingTypes([clamav, grype, trivy], [failure("clamav"), failure("grype")]),
    ).toEqual(["malware"]);
  });

  test("custom gating set treats a dropped vuln source as uncovered", () => {
    expect(
      uncoveredGatingFindingTypes(
        [clamav, grype],
        [failure("grype")],
        new Set<FindingType>(["vuln"]),
      ),
    ).toEqual(["vuln"]);
  });

  test("malware is a gating finding type", () => {
    expect(GATING_FINDING_TYPES.has("malware")).toBe(true);
  });
});
