import { describe, expect, test } from "bun:test";
import { dedupeFindings, evaluateScanPolicy } from "./scan-policy";

describe("scan policy helpers", () => {
  test("deduplicates findings by type, vulnerability/title, and package identity", () => {
    const findings = dedupeFindings([
      {
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/a@1.0.0",
        packageName: "a",
        severity: "high",
      },
      {
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/a@1.0.0",
        packageName: "a",
        severity: "critical",
      },
      {
        type: "malware",
        title: "EICAR",
        packageName: "payload",
        severity: "critical",
      },
    ]);

    expect(findings).toHaveLength(2);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[1]?.type).toBe("malware");
  });

  test("quarantines audit-mode policy violations and blocks enforce-mode violations", () => {
    const findings = [
      {
        type: "vuln" as const,
        severity: "high" as const,
        cvssScore: 8.5,
        packageName: "openssl",
      },
    ];

    expect(
      evaluateScanPolicy(findings, { blockOnSeverity: "medium", mode: "audit" }),
    ).toMatchObject({
      highest: "high",
      maxCvss: 8.5,
      state: "quarantined",
      reasons: { severityViolates: true },
    });

    expect(evaluateScanPolicy(findings, { blockOnSeverity: "medium", mode: "enforce" }).state).toBe(
      "blocked",
    );
  });

  test("applies malware, CVSS, and license gates", () => {
    const findings = [
      { type: "malware" as const, severity: "unknown" as const, title: "EICAR" },
      { type: "license" as const, severity: "negligible" as const, title: "GPL-3.0" },
      { type: "vuln" as const, severity: "low" as const, cvssScore: 9.1 },
    ];

    expect(
      evaluateScanPolicy(findings, {
        blockOnSeverity: "critical",
        blockOnMalware: "true",
        denyLicenses: ["GPL-3.0"],
        maxCvss: 9,
      }),
    ).toMatchObject({
      state: "quarantined",
      reasons: {
        malwareViolates: true,
        cvssViolates: true,
        licenseViolates: true,
      },
    });
  });
});
