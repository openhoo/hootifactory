import { describe, expect, test } from "bun:test";
import { isVersionVulnerable, scanDependenciesAgainstAdvisories } from "./advisories";

describe("advisory version gating", () => {
  test("does not flag a dependency on the advisory's fixed version", () => {
    // log4shell-js is fixed in 2.17.0 — the documented patched release must clear the gate.
    expect(scanDependenciesAgainstAdvisories({ "log4shell-js": "2.17.0" })).toEqual([]);
    // left-pad-vuln is fixed in 1.3.1.
    expect(scanDependenciesAgainstAdvisories({ "left-pad-vuln": "1.3.1" })).toEqual([]);
  });

  test("does not flag a dependency above the advisory's fixed version", () => {
    expect(scanDependenciesAgainstAdvisories({ "log4shell-js": "2.18.0" })).toEqual([]);
    expect(scanDependenciesAgainstAdvisories({ "left-pad-vuln": "2.0.0" })).toEqual([]);
    // Range operators / `v` prefix on a patched release still clear the gate.
    expect(scanDependenciesAgainstAdvisories({ "log4shell-js": "^2.17.1" })).toEqual([]);
    expect(scanDependenciesAgainstAdvisories({ "left-pad-vuln": "v1.4.0" })).toEqual([]);
  });

  test("flags a dependency strictly below the advisory's fixed version", () => {
    const [finding] = scanDependenciesAgainstAdvisories({ "log4shell-js": "2.16.0" });
    expect(finding).toMatchObject({
      vulnId: "HOOT-2024-0003",
      packageName: "log4shell-js",
      packageVersion: "2.16.0",
      fixedVersion: "2.17.0",
    });
    expect(
      scanDependenciesAgainstAdvisories({ "left-pad-vuln": "1.3.0" }).map((f) => f.vulnId),
    ).toEqual(["HOOT-2024-0002"]);
  });

  test("flags a dependency with an unparseable version (fail-safe)", () => {
    expect(
      scanDependenciesAgainstAdvisories({ "log4shell-js": "latest" }).map((f) => f.vulnId),
    ).toEqual(["HOOT-2024-0003"]);
    expect(scanDependenciesAgainstAdvisories({ "left-pad-vuln": "" }).map((f) => f.vulnId)).toEqual(
      ["HOOT-2024-0002"],
    );
  });

  test("flags an advisory with no known fixed version at every version", () => {
    // evil-dep is known-malicious: no patched release exists, so any version is flagged.
    expect(scanDependenciesAgainstAdvisories({ "evil-dep": "9.9.9" }).map((f) => f.vulnId)).toEqual(
      ["HOOT-2024-0001"],
    );
  });

  test("ignores dependencies not present in the advisory DB", () => {
    expect(scanDependenciesAgainstAdvisories({ safe: "1.0.0", "another-dep": "2.0.0" })).toEqual(
      [],
    );
  });
});

describe("isVersionVulnerable", () => {
  test("treats a missing fixed version as always vulnerable", () => {
    expect(isVersionVulnerable("1.0.0", undefined)).toBe(true);
  });

  test("is vulnerable strictly below the fixed version", () => {
    expect(isVersionVulnerable("2.16.0", "2.17.0")).toBe(true);
    expect(isVersionVulnerable("2.17.0", "2.17.0")).toBe(false);
    expect(isVersionVulnerable("2.18.0", "2.17.0")).toBe(false);
  });

  test("compares release fields numerically rather than lexicographically", () => {
    // "2.9.0" must compare below "2.10.0", which a string comparison would get wrong.
    expect(isVersionVulnerable("2.9.0", "2.10.0")).toBe(true);
    expect(isVersionVulnerable("2.10.0", "2.9.0")).toBe(false);
  });

  test("tolerates differing field counts and pre-release suffixes", () => {
    expect(isVersionVulnerable("2.17", "2.17.0")).toBe(false);
    expect(isVersionVulnerable("2.17.0-rc1", "2.17.0")).toBe(false);
    expect(isVersionVulnerable("2.16.9-rc1", "2.17.0")).toBe(true);
  });

  test("falls back to vulnerable when a version cannot be parsed", () => {
    expect(isVersionVulnerable("latest", "2.17.0")).toBe(true);
    expect(isVersionVulnerable("2.17.0", "unknown")).toBe(true);
  });
});
