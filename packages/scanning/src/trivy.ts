import { resolve } from "node:path";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import { asRecord, asString } from "./scanner-json";
import {
  type AvailableScanners,
  coerceScannerOptions,
  DEFAULT_SCANNER_IMAGES,
  runScannerAndParse,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

export function parseTrivyFindings(data: unknown): NormalizedFinding[] {
  const root = asRecord(data);
  const results = Array.isArray(root?.Results) ? root.Results : [];
  const findings: NormalizedFinding[] = [];
  for (const result of results) {
    const row = asRecord(result);
    const vulnerabilities = Array.isArray(row?.Vulnerabilities) ? row.Vulnerabilities : [];
    for (const vulnerability of vulnerabilities) {
      const vuln = asRecord(vulnerability);
      const identifier = asRecord(vuln?.PkgIdentifier);
      findings.push({
        type: "vuln",
        vulnId: asString(vuln?.VulnerabilityID),
        severity: normalizeSeverity(asString(vuln?.Severity)),
        packageName: asString(vuln?.PkgName),
        packageVersion: asString(vuln?.InstalledVersion),
        fixedVersion: asString(vuln?.FixedVersion),
        title: asString(vuln?.Title),
        description: asString(vuln?.Description),
        purl: asString(identifier?.PURL),
      });
    }
  }
  return findings;
}

export function trivyFsArgs(target: string, serverUrl?: string): string[] {
  return [
    "fs",
    "--quiet",
    "--format",
    "json",
    ...(serverUrl ? ["--server", serverUrl] : []),
    target,
  ];
}

export async function runTrivyIfAvailable(
  target: string,
  serverUrlOrOptions?: string | ScannerRuntimeOptions,
  scanners?: AvailableScanners,
): Promise<NormalizedFinding[]> {
  const options = coerceScannerOptions(serverUrlOrOptions, "trivyServerUrl");
  const resolvedTarget = resolve(target);
  return runScannerAndParse("trivy", {
    args: trivyFsArgs(resolvedTarget, options.trivyServerUrl),
    hostBins: ["trivy"],
    image: options.trivyImage ?? DEFAULT_SCANNER_IMAGES.trivy,
    options,
    parse: (text) => parseTrivyFindings(JSON.parse(text)),
    requireOutput: true,
    scanners,
    target: resolvedTarget,
  });
}
