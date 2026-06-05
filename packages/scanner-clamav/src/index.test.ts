import { describe, expect, test } from "bun:test";
import { createTestContentTarget, resolveTestScanner } from "@hootifactory/scanner/testing";
import { clamavScanner, parseClamAvRestFindings } from "./index";

describe("clamav scanner", () => {
  test("maps ClamAV REST responses", () => {
    expect(parseClamAvRestFindings({ infected: true, viruses: ["Eicar-Test-Signature"] })).toEqual([
      {
        type: "malware",
        severity: "critical",
        vulnId: "CLAMAV:Eicar-Test-Signature",
        title: "ClamAV detected Eicar-Test-Signature",
      },
    ]);
  });

  test("treats a configured REST endpoint as available even with the CLI runtime disabled", () => {
    const withRest = resolveTestScanner(clamavScanner, {
      env: { CLAMAV_REST_URL: "http://clamav:3310/scan" },
      runtime: { cliRuntime: "disabled" },
    });
    expect(withRest.available).toBe(true);
    expect(clamavScanner.requiresExternalRuntime?.(withRest.config)).toBe(true);

    const withoutRest = resolveTestScanner(clamavScanner, { runtime: { cliRuntime: "disabled" } });
    expect(withoutRest.available).toBe(false);
  });

  test("posts artifact bytes to the REST endpoint and maps the response", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Parameters<typeof fetch>[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls.push(args);
      return Response.json({ infected: true, signature: "Rest-Malware" });
    }) as unknown as typeof fetch;
    try {
      const config = clamavScanner.configFromEnv({
        env: { CLAMAV_REST_URL: "http://clamav/scan" },
        runtime: { cliRuntime: "disabled" },
        isProduction: false,
      });
      const bytes = new TextEncoder().encode("payload");
      const findings = await clamavScanner.scanContent?.(createTestContentTarget(bytes), config, {
        runtime: { cliRuntime: "disabled" },
      });
      expect(findings).toEqual([
        {
          type: "malware",
          severity: "critical",
          vulnId: "CLAMAV:Rest-Malware",
          title: "ClamAV detected Rest-Malware",
        },
      ]);
      expect(calls[0]?.[0]).toBe("http://clamav/scan");
      expect((calls[0]?.[1] as RequestInit).method).toBe("POST");
      expect((calls[0]?.[1] as RequestInit).body).toBe(bytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
