import { describe, expect, test } from "bun:test";
import { resolveTestScanner } from "@hootifactory/scanner/testing";
import { parseTrivyFindings, trivyFsArgs, trivyScanner } from "./index";

describe("trivy scanner", () => {
  test("includes server-mode CLI args", () => {
    expect(trivyFsArgs("/tmp/pkg", "http://trivy:4954")).toEqual([
      "fs",
      "--quiet",
      "--format",
      "json",
      "--server",
      "http://trivy:4954",
      "/tmp/pkg",
    ]);
  });

  test("maps Trivy JSON vulnerabilities", () => {
    expect(
      parseTrivyFindings({
        Results: [
          {
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-2026-0001",
                Severity: "CRITICAL",
                PkgName: "openssl",
                InstalledVersion: "1.0.0",
                FixedVersion: "1.0.1",
                Title: "test vulnerability",
                PkgIdentifier: { PURL: "pkg:apk/alpine/openssl@1.0.0" },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        type: "vuln",
        vulnId: "CVE-2026-0001",
        severity: "critical",
        packageName: "openssl",
        packageVersion: "1.0.0",
        fixedVersion: "1.0.1",
        title: "test vulnerability",
        description: undefined,
        purl: "pkg:apk/alpine/openssl@1.0.0",
      },
    ]);
  });

  test("reports an external runtime requirement when a server URL is configured", () => {
    const resolved = resolveTestScanner(trivyScanner, {
      env: { TRIVY_SERVER_URL: "http://trivy:4954/" },
    });
    expect(trivyScanner.requiresExternalRuntime?.(resolved.config)).toBe(true);
    expect(
      trivyScanner.requiresExternalRuntime?.(
        trivyScanner.configFromEnv({
          env: {},
          runtime: { cliRuntime: "host" },
          isProduction: false,
        }),
      ),
    ).toBe(false);
  });

  test("rejects an unpinned image under the production Docker runtime", () => {
    expect(() =>
      trivyScanner.configFromEnv({
        env: { TRIVY_IMAGE: "aquasec/trivy:latest" },
        runtime: { cliRuntime: "docker" },
        isProduction: true,
      }),
    ).toThrow(/TRIVY_IMAGE must be pinned/);
  });
});
