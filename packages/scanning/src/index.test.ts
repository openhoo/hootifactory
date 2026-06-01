import { describe, expect, test } from "bun:test";
import { osvScanDependencies, scanDependencies, scanForMalware } from "./index";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe("heuristic scanning", () => {
  test("flags dependencies from the built-in advisory database", () => {
    const findings = scanDependencies({
      "evil-dep": "^1.2.3",
      safe: "1.0.0",
      "left-pad-vuln": "~1.0.0",
    });

    expect(findings.map((finding) => finding.vulnId)).toEqual(["HOOT-2024-0001", "HOOT-2024-0002"]);
    expect(findings[0]).toMatchObject({
      type: "vuln",
      severity: "critical",
      packageName: "evil-dep",
      packageVersion: "^1.2.3",
      fixedVersion: "0.0.0",
    });
  });

  test("detects the EICAR malware signature in the scanned byte window", () => {
    expect(scanForMalware(new TextEncoder().encode(`prefix ${EICAR} suffix`))).toEqual([
      {
        type: "malware",
        severity: "critical",
        vulnId: "EICAR-TEST",
        title: "EICAR antivirus test signature detected",
      },
    ]);
    expect(scanForMalware(new TextEncoder().encode("plain package bytes"))).toEqual([]);
  });

  test("maps OSV batch matches and strips common semver range prefixes", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Parameters<typeof fetch>[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls.push(args);
      return Response.json({
        results: [{ vulns: [{ id: "GHSA-123" }] }, { vulns: [] }],
      });
    }) as unknown as typeof fetch;

    try {
      const findings = await osvScanDependencies(
        "npm",
        { vulnerable: "^1.2.3", safe: ">=2.0.0" },
        "https://osv.test",
      );

      expect(calls).toHaveLength(1);
      const [url, init] = calls[0]!;
      expect(url).toBe("https://osv.test/v1/querybatch");
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        queries: [
          { package: { ecosystem: "npm", name: "vulnerable" }, version: "1.2.3" },
          { package: { ecosystem: "npm", name: "safe" }, version: "2.0.0" },
        ],
      });
      expect(findings).toEqual([
        {
          type: "vuln",
          vulnId: "GHSA-123",
          severity: "high",
          packageName: "vulnerable",
          packageVersion: "1.2.3",
          purl: "pkg:npm/vulnerable@1.2.3",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
