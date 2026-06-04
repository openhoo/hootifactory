import { resolve } from "node:path";
import { safeJsonParse, z } from "@hootifactory/core";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import {
  type AvailableScanners,
  coerceScannerOptions,
  DEFAULT_SCANNER_IMAGES,
  runScannerAndParse,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

const NonEmptyScannerStringSchema = z.string().min(1);
const TrivyRootSchema = z.looseObject({
  Results: z.array(z.unknown()).optional(),
});
const TrivyResultSchema = z.looseObject({
  Vulnerabilities: z.array(z.unknown()).optional(),
});
const TrivyVulnerabilitySchema = z.looseObject({
  Description: z.unknown().optional(),
  FixedVersion: z.unknown().optional(),
  InstalledVersion: z.unknown().optional(),
  PkgIdentifier: z.unknown().optional(),
  PkgName: z.unknown().optional(),
  Severity: z.unknown().optional(),
  Title: z.unknown().optional(),
  VulnerabilityID: z.unknown().optional(),
});
const TrivyPackageIdentifierSchema = z.looseObject({
  PURL: z.unknown().optional(),
});

export function parseTrivyFindings(data: unknown): NormalizedFinding[] {
  const root = TrivyRootSchema.safeParse(data);
  const results = root.success ? (root.data.Results ?? []) : [];
  const findings: NormalizedFinding[] = [];
  for (const result of results) {
    const row = TrivyResultSchema.safeParse(result);
    const vulnerabilities = row.success ? (row.data.Vulnerabilities ?? []) : [];
    for (const vulnerability of vulnerabilities) {
      const vuln = TrivyVulnerabilitySchema.safeParse(vulnerability);
      const identifier = TrivyPackageIdentifierSchema.safeParse(
        vuln.success ? vuln.data.PkgIdentifier : undefined,
      );
      findings.push({
        type: "vuln",
        vulnId: scannerString(vuln.success ? vuln.data.VulnerabilityID : undefined),
        severity: normalizeSeverity(scannerString(vuln.success ? vuln.data.Severity : undefined)),
        packageName: scannerString(vuln.success ? vuln.data.PkgName : undefined),
        packageVersion: scannerString(vuln.success ? vuln.data.InstalledVersion : undefined),
        fixedVersion: scannerString(vuln.success ? vuln.data.FixedVersion : undefined),
        title: scannerString(vuln.success ? vuln.data.Title : undefined),
        description: scannerString(vuln.success ? vuln.data.Description : undefined),
        purl: scannerString(identifier.success ? identifier.data.PURL : undefined),
      });
    }
  }
  return findings;
}

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
    parse: (text) => {
      const decoded = safeJsonParse(text);
      if (!decoded.success) throw decoded.error;
      return parseTrivyFindings(decoded.data);
    },
    requireOutput: true,
    scanners,
    target: resolvedTarget,
  });
}
