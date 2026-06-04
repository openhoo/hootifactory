import { describe, expect, test } from "bun:test";
import {
  detectScanners,
  dockerScannerRunArgs,
  osvScanDependencies,
  parseClamAvRestFindings,
  parseTrivyFindings,
  runClamAvIfAvailable,
  scanDependencies,
  scanForMalware,
  trivyFsArgs,
} from "./index";

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

  test("detects the EICAR malware signature after the old 8 KiB scan window", () => {
    const signature = new TextEncoder().encode(EICAR);
    const bytes = new Uint8Array(8192 + signature.length);
    bytes.set(signature, 8192);

    expect(scanForMalware(bytes)).toEqual([
      {
        type: "malware",
        severity: "critical",
        vulnId: "EICAR-TEST",
        title: "EICAR antivirus test signature detected",
      },
    ]);
  });

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
      const findings = await osvScanDependencies(
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
          database_specific: {
            severity: url.endsWith("GHSA-456") ? "medium" : "critical",
          },
        });
      }
      return Response.json({
        results: [{ vulns: [{ id: "GHSA-123" }] }, { vulns: [{ id: "GHSA-456" }] }],
      });
    }) as unknown as typeof fetch;

    try {
      const findings = await osvScanDependencies(
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

  test("maps Trivy JSON vulnerabilities and includes server-mode CLI args", () => {
    expect(trivyFsArgs("/tmp/pkg", "http://trivy:4954")).toEqual([
      "fs",
      "--quiet",
      "--format",
      "json",
      "--server",
      "http://trivy:4954",
      "/tmp/pkg",
    ]);
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

  test("builds Docker scanner commands with target bind mounts", () => {
    const args = dockerScannerRunArgs({
      args: ["fs", "--quiet", "--format", "json", "/tmp/hoot-scan/blob"],
      image: "aquasec/trivy:latest",
      options: {
        dockerCpus: "1.5",
        dockerMemory: "512m",
        dockerPidsLimit: 128,
        dockerStorageSize: "2g",
      },
      cidFile: "/tmp/hoot-scan/scanner.cid",
      target: "/tmp/hoot-scan/blob",
    });

    expect(args).toContain("--pull");
    expect(args).toContain("missing");
    expect(args).toContain("--memory");
    expect(args).toContain("512m");
    expect(args).toContain("--memory-swap");
    expect(args).toContain("--cpus");
    expect(args).toContain("1.5");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("128");
    expect(args).toContain("--ulimit");
    expect(args).toContain("nproc=128:128");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/tmp:rw,noexec,nosuid,size=64m,mode=1777");
    expect(args).toContain("/var/tmp:rw,noexec,nosuid,size=64m,mode=1777");
    const userIndex = args.indexOf("--user");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(args[userIndex + 1]).toMatch(/^\d+:\d+$/);
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(args).not.toContain("host");
    expect(args).not.toContain("--add-host");
    expect(args).toContain("--storage-opt");
    expect(args).toContain("size=2g");
    expect(args).toContain("--cidfile");
    expect(args).toContain("/tmp/hoot-scan/scanner.cid");
    expect(args).toContain("type=bind,source=/tmp/hoot-scan,target=/tmp/hoot-scan,readonly");
    expect(args).toContain("aquasec/trivy:latest");
    expect(args.slice(-5)).toEqual(["fs", "--quiet", "--format", "json", "/tmp/hoot-scan/blob"]);
  });

  test("maps ClamAV REST responses and treats configured REST as available", async () => {
    expect(
      detectScanners({ clamavRestUrl: "http://clamav:3310/scan", cliRuntime: "disabled" }).clamav,
    ).toBe(true);
    expect(detectScanners({ cliRuntime: "disabled" }).grype).toBe(false);
    expect(parseClamAvRestFindings({ infected: true, viruses: ["Eicar-Test-Signature"] })).toEqual([
      {
        type: "malware",
        severity: "critical",
        vulnId: "CLAMAV:Eicar-Test-Signature",
        title: "ClamAV detected Eicar-Test-Signature",
      },
    ]);

    const originalFetch = globalThis.fetch;
    const calls: Parameters<typeof fetch>[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls.push(args);
      return Response.json({ infected: true, signature: "Rest-Malware" });
    }) as unknown as typeof fetch;
    try {
      const bytes = new TextEncoder().encode("payload");
      await expect(
        runClamAvIfAvailable("/tmp/payload", bytes, "http://clamav/scan"),
      ).resolves.toEqual([
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
