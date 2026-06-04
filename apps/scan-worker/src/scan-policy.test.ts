import { describe, expect, test } from "bun:test";
import { createTtlPromiseCache, dedupeFindings, evaluateScanPolicy } from "./scan-policy";

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

  test("caches promise results until the TTL expires", async () => {
    let calls = 0;
    const cache = createTtlPromiseCache(async (key: string) => {
      calls += 1;
      return `${key}:${calls}`;
    }, 100);

    await expect(cache.get("org-1", 1_000)).resolves.toBe("org-1:1");
    await expect(cache.get("org-1", 1_050)).resolves.toBe("org-1:1");
    await expect(cache.get("org-1", 1_101)).resolves.toBe("org-1:2");
    expect(calls).toBe(2);
  });

  test("invalidates cached promise results", async () => {
    let calls = 0;
    const cache = createTtlPromiseCache(async () => {
      calls += 1;
      return calls;
    }, 100);

    await expect(cache.get("org-1", 1_000)).resolves.toBe(1);
    cache.invalidate("org-1");
    await expect(cache.get("org-1", 1_050)).resolves.toBe(2);
  });

  test("evicts failed promise results", async () => {
    let calls = 0;
    const cache = createTtlPromiseCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("db unavailable");
      return calls;
    }, 100);

    await expect(cache.get("org-1", 1_000)).rejects.toThrow("db unavailable");
    await expect(cache.get("org-1", 1_050)).resolves.toBe(2);
  });
});
