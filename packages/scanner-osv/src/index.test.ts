import { describe, expect, test } from "bun:test";
import { createTestDependencyTarget, resolveTestScanner } from "@hootifactory/scanner/testing";
import { osvScanner } from "./index";

describe("osv scanner plugin", () => {
  test("declares a network-bound dependency scanner", () => {
    expect(osvScanner.id).toBe("osv");
    expect(osvScanner.capabilities.inputKind).toBe("dependencies");
    expect(osvScanner.capabilities.network).toBe(true);
  });

  test("is opt-in via SCANNER_OSV and overridable via OSV_API_URL", () => {
    const disabled = resolveTestScanner(osvScanner);
    expect(disabled.config.enabled).toBe(false);
    expect(disabled.available).toBe(false);
    expect(disabled.config.apiUrl).toBe("https://api.osv.dev");

    const enabled = resolveTestScanner(osvScanner, {
      env: { SCANNER_OSV: "TRUE", OSV_API_URL: "https://osv.internal/" },
    });
    expect(enabled.config.enabled).toBe(true);
    expect(enabled.available).toBe(true);
    // Trailing slash stripped.
    expect(enabled.config.apiUrl).toBe("https://osv.internal");
  });

  test("treats unrecognized SCANNER_OSV values as disabled", () => {
    expect(resolveTestScanner(osvScanner, { env: { SCANNER_OSV: "maybe" } }).config.enabled).toBe(
      false,
    );
  });

  test("returns [] without a network call when the target has no ecosystem", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      const config = osvScanner.configFromEnv({
        env: { SCANNER_OSV: "1" },
        runtime: { cliRuntime: "host" },
        isProduction: false,
      });
      const findings = await osvScanner.scanDependencies?.(
        createTestDependencyTarget({ lodash: "1.0.0" }, { ecosystem: "" }),
        config,
        { runtime: { cliRuntime: "host" } },
      );
      expect(findings).toEqual([]);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps OSV findings for a configured ecosystem", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/v1/vulns/")) {
        return Response.json({ database_specific: { severity: "critical" } });
      }
      return Response.json({ results: [{ vulns: [{ id: "GHSA-xyz" }] }] });
    }) as unknown as typeof fetch;
    try {
      const config = osvScanner.configFromEnv({
        env: { SCANNER_OSV: "1", OSV_API_URL: "https://osv.test" },
        runtime: { cliRuntime: "host" },
        isProduction: false,
      });
      const findings = await osvScanner.scanDependencies?.(
        createTestDependencyTarget({ vulnerable: "^1.2.3" }),
        config,
        { runtime: { cliRuntime: "host", timeoutMs: 1_000 } },
      );
      expect(findings).toEqual([
        {
          type: "vuln",
          vulnId: "GHSA-xyz",
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

  test("rethrows a total OSV outage so the worker can observe it (fail-open at the fan-out)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    try {
      const config = osvScanner.configFromEnv({
        env: { SCANNER_OSV: "1", OSV_API_URL: "https://osv.test" },
        runtime: { cliRuntime: "host" },
        isProduction: false,
      });
      await expect(
        osvScanner.scanDependencies?.(createTestDependencyTarget({ a: "1.0.0" }), config, {
          runtime: { cliRuntime: "host" },
        }),
      ).rejects.toThrow(/OSV querybatch failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
