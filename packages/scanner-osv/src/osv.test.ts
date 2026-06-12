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

  test("prefers a CVSS severity score over database_specific when both are present", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/v1/vulns/")) {
        return Response.json({
          database_specific: { severity: "low" },
          severity: [{ score: "CRITICAL" }],
        });
      }
      return Response.json({ results: [{ vulns: [{ id: "GHSA-cvss" }] }] });
    }) as unknown as typeof fetch;
    try {
      const { findings } = await osvScanDependencies("npm", { pkg: "1.0.0" }, "https://osv.test");
      expect(findings.map((f) => [f.vulnId, f.severity])).toEqual([["GHSA-cvss", "critical"]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("derives severity and cvssScore from CVSS v3 vectors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/v1/vulns/")) {
        return Response.json({
          database_specific: { severity: "low" },
          severity: [
            {
              type: "CVSS_V3",
              score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
            },
          ],
        });
      }
      return Response.json({ results: [{ vulns: [{ id: "GHSA-cvss-v3" }] }] });
    }) as unknown as typeof fetch;
    try {
      const { findings } = await osvScanDependencies("npm", { pkg: "^1.0.0" }, "https://osv.test");
      expect(findings).toEqual([
        {
          type: "vuln",
          vulnId: "GHSA-cvss-v3",
          severity: "critical",
          cvssScore: 9.8,
          packageName: "pkg",
          packageVersion: "1.0.0",
          purl: "pkg:npm/pkg@1.0.0",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("derives severity and cvssScore from CVSS v2 vectors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/v1/vulns/")) {
        return Response.json({
          severity: [
            {
              type: "CVSS_V2",
              score: "CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P",
            },
          ],
        });
      }
      return Response.json({ results: [{ vulns: [{ id: "GHSA-cvss-v2" }] }] });
    }) as unknown as typeof fetch;
    try {
      const { findings } = await osvScanDependencies("npm", { pkg: "~2.0.0" }, "https://osv.test");
      expect(findings).toEqual([
        {
          type: "vuln",
          vulnId: "GHSA-cvss-v2",
          severity: "high",
          cvssScore: 7.5,
          packageName: "pkg",
          packageVersion: "2.0.0",
          purl: "pkg:npm/pkg@2.0.0",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("defaults to high severity when the vuln detail lookup itself fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/v1/vulns/")) throw new Error("detail unreachable");
      return Response.json({ results: [{ vulns: [{ id: "GHSA-nodetail" }] }] });
    }) as unknown as typeof fetch;
    try {
      const { findings, error } = await osvScanDependencies(
        "npm",
        { pkg: "1.0.0" },
        "https://osv.test",
      );
      expect(error).toBeUndefined();
      expect(findings.map((f) => [f.vulnId, f.severity])).toEqual([["GHSA-nodetail", "high"]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns the error when the batch request throws (network failure)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    try {
      const result = await osvScanDependencies("npm", { a: "1.0.0" }, "https://osv.test");
      expect(result.findings).toEqual([]);
      expect((result.error as Error).message).toBe("connection refused");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns no findings without a network call for an empty dependency set", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      expect(await osvScanDependencies("npm", {})).toEqual({ findings: [] });
      expect(await osvScanDependencies("npm", undefined)).toEqual({ findings: [] });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
