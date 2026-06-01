import { describe, expect, test } from "bun:test";
import {
  findingKey,
  isValidRepositoryPattern,
  maxSeverity,
  normalizeSeverity,
  repositoryPatternMatches,
  resolveScanPolicy,
} from "./index";

describe("scan-core severity helpers", () => {
  test("normalizes scanner severity labels to the canonical scale", () => {
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
    expect(normalizeSeverity("moderate")).toBe("medium");
    expect(normalizeSeverity("informational")).toBe("negligible");
    expect(normalizeSeverity(undefined)).toBe("unknown");
    expect(normalizeSeverity("not-a-real-severity")).toBe("unknown");
  });

  test("selects the higher severity", () => {
    expect(maxSeverity("low", "high")).toBe("high");
    expect(maxSeverity("critical", "medium")).toBe("critical");
    expect(maxSeverity("unknown", "negligible")).toBe("negligible");
  });

  test("builds stable finding dedupe keys", () => {
    expect(
      findingKey({
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/example@1.0.0",
        severity: "high",
      }),
    ).toBe("vuln:CVE-1:pkg:npm/example@1.0.0");

    expect(
      findingKey({ type: "malware", title: "EICAR", packageName: "payload", severity: "critical" }),
    ).toBe("malware:EICAR:payload");
  });

  test("validates repository policy patterns conservatively", () => {
    expect(isValidRepositoryPattern("*")).toBe(true);
    expect(isValidRepositoryPattern("scan-*")).toBe(true);
    expect(isValidRepositoryPattern("scan.prod_1")).toBe(true);
    expect(isValidRepositoryPattern("")).toBe(false);
    expect(isValidRepositoryPattern("**")).toBe(false);
    expect(isValidRepositoryPattern("../repo")).toBe(false);
    expect(isValidRepositoryPattern("repo/name")).toBe(false);
  });

  test("matches scan policy repository globs against repository names", () => {
    expect(repositoryPatternMatches("*", "scan-prod")).toBe(true);
    expect(repositoryPatternMatches("scan-*", "scan-prod")).toBe(true);
    expect(repositoryPatternMatches("scan-*", "prod-scan")).toBe(false);
    expect(repositoryPatternMatches("scan-prod", "scan-prod")).toBe(true);
    expect(repositoryPatternMatches("scan-prod", "scan-prod-canary")).toBe(false);
  });

  test("resolves scan policies by specificity and deterministic newest tie-break", () => {
    const rows = [
      {
        id: "wild",
        repositoryPattern: "*",
        mode: "enforce",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        id: "glob",
        repositoryPattern: "scan-*",
        mode: "audit",
        createdAt: new Date("2025-01-02T00:00:00Z"),
      },
      {
        id: "exact-old",
        repositoryPattern: "scan-prod",
        mode: "enforce",
        createdAt: new Date("2025-01-03T00:00:00Z"),
      },
      {
        id: "exact-new",
        repositoryPattern: "scan-prod",
        mode: "audit",
        createdAt: new Date("2025-01-04T00:00:00Z"),
      },
    ];

    expect(resolveScanPolicy(rows, "scan-canary")?.id).toBe("glob");
    expect(resolveScanPolicy(rows, "other")?.id).toBe("wild");
    expect(resolveScanPolicy(rows, "scan-prod")?.id).toBe("exact-new");
  });
});
