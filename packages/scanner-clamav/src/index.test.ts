import { describe, expect, test } from "bun:test";
import { createTestContentTarget, resolveTestScanner } from "@hootifactory/scanner/testing";
import { clamavScanner, parseClamAvCliFindings, parseClamAvRestFindings } from "./index";

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

  test("extracts named findings from object-shaped REST match entries, deduping by name", () => {
    const findings = parseClamAvRestFindings({
      matches: [{ name: "Win.Test.A" }, { signature: "Unix.Test.B" }, { virus: "Win.Test.A" }],
      found: [{ irrelevant: true }, "Eicar-Test-Signature"],
    });
    expect(findings.map((f) => f.vulnId)).toEqual([
      "CLAMAV:Win.Test.A",
      "CLAMAV:Unix.Test.B",
      "CLAMAV:Eicar-Test-Signature",
    ]);
  });

  test("falls back to a generic malware finding when only `infected` is set", () => {
    expect(parseClamAvRestFindings({ infected: true })).toEqual([
      {
        type: "malware",
        severity: "critical",
        vulnId: "CLAMAV-DETECTED",
        title: "ClamAV detected malware",
      },
    ]);
  });

  test("reads a top-level signature/virus/name field", () => {
    expect(parseClamAvRestFindings({ virus: "Top.Level.Virus" }).map((f) => f.vulnId)).toEqual([
      "CLAMAV:Top.Level.Virus",
    ]);
  });

  test("returns no findings for a clean or unparseable REST response", () => {
    expect(parseClamAvRestFindings({ infected: false })).toEqual([]);
    expect(parseClamAvRestFindings("not an object")).toEqual([]);
  });

  test("parses `FOUND` lines from clamscan CLI output, deduping repeats", () => {
    const output = [
      "/scan/blob: Eicar-Test-Signature FOUND",
      "/scan/other: Win.Test.C FOUND",
      "/scan/dup: Eicar-Test-Signature FOUND",
      "/scan/clean: OK",
    ].join("\n");
    expect(parseClamAvCliFindings(output).map((f) => f.vulnId)).toEqual([
      "CLAMAV:Eicar-Test-Signature",
      "CLAMAV:Win.Test.C",
    ]);
    expect(parseClamAvCliFindings("nothing here")).toEqual([]);
  });

  test("is unavailable and needs no external runtime without a REST URL or CLI runtime", () => {
    // No REST URL and the CLI runtime disabled => deterministically unavailable.
    const disabled = resolveTestScanner(clamavScanner, { runtime: { cliRuntime: "disabled" } });
    expect(disabled.available).toBe(false);
    expect(clamavScanner.requiresExternalRuntime?.(disabled.config)).toBe(false);
  });

  test("rejects an unpinned image under the production Docker runtime", () => {
    expect(() =>
      clamavScanner.configFromEnv({
        env: { CLAMAV_IMAGE: "clamav/clamav:latest" },
        runtime: { cliRuntime: "docker" },
        isProduction: true,
      }),
    ).toThrow(/CLAMAV_IMAGE must be pinned/);
  });

  test("surfaces a non-2xx REST response as an error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    try {
      const config = clamavScanner.configFromEnv({
        env: { CLAMAV_REST_URL: "http://clamav/scan" },
        runtime: { cliRuntime: "disabled" },
        isProduction: false,
      });
      await expect(
        clamavScanner.scanContent?.(createTestContentTarget(new Uint8Array()), config, {
          runtime: { cliRuntime: "disabled" },
        }),
      ).rejects.toThrow(/clamav REST returned 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
