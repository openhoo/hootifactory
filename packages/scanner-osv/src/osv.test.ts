import { describe, expect, test } from "bun:test";
import { osvScanDependencies } from "./osv";

describe("osvScanDependencies", () => {
  test("maps OSV batch matches and strips common semver range prefixes", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Parameters<typeof fetch>[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls.push(args);
      if (String(args[0]).endsWith("/v1/vulns/GHSA-123")) {
        return Response.json({ database_specific: { severity: "critical" } });
      }
      return Response.json({
        results: [{ vulns: [{ id: "GHSA-123" }, { id: 123 }, null] }, { vulns: [] }],
      });
    }) as unknown as typeof fetch;

    try {
      const { findings } = await osvScanDependencies(
        "npm",
        { vulnerable: "^1.2.3", safe: ">=2.0.0" },
        "https://osv.test",
      );

      expect(calls).toHaveLength(2);
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
          severity: "critical",
          packageName: "vulnerable",
          packageVersion: "1.2.3",
          purl: "pkg:npm/vulnerable@1.2.3",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves OSV vulnerability severities concurrently", async () => {
    const originalFetch = globalThis.fetch;
    let inFlightDetails = 0;
    let maxInFlightDetails = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes("/v1/vulns/")) {
        inFlightDetails += 1;
        maxInFlightDetails = Math.max(maxInFlightDetails, inFlightDetails);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlightDetails -= 1;
        return Response.json({
          database_specific: { severity: url.endsWith("GHSA-456") ? "medium" : "critical" },
        });
      }
      return Response.json({
        results: [{ vulns: [{ id: "GHSA-123" }] }, { vulns: [{ id: "GHSA-456" }] }],
      });
    }) as unknown as typeof fetch;

    try {
      const { findings } = await osvScanDependencies(
        "npm",
        { first: "1.0.0", second: "2.0.0" },
        "https://osv.test",
      );
      expect(maxInFlightDetails).toBe(2);
      expect(findings.map((finding) => [finding.vulnId, finding.severity])).toEqual([
        ["GHSA-123", "critical"],
        ["GHSA-456", "medium"],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns an error (fail-open) when the lookup cannot be completed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    try {
      const result = await osvScanDependencies("npm", { a: "1.0.0" }, "https://osv.test");
      expect(result.findings).toEqual([]);
      expect(result.error).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
