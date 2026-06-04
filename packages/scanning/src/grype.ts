import { resolve } from "node:path";
import { safeJsonParse, z } from "@hootifactory/core";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import {
  type AvailableScanners,
  DEFAULT_SCANNER_IMAGES,
  runScannerAndParse,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

const NonEmptyScannerStringSchema = z.string().min(1);
const GrypeOutputSchema = z.looseObject({
  matches: z.array(z.unknown()).optional(),
});
const GrypeMatchSchema = z.looseObject({
  artifact: z.unknown().optional(),
  vulnerability: z.unknown().optional(),
});
const GrypeVulnerabilitySchema = z.looseObject({
  fix: z.unknown().optional(),
  id: z.unknown().optional(),
  severity: z.unknown().optional(),
});
const GrypeFixSchema = z.looseObject({
  versions: z.array(z.unknown()).optional(),
});
const GrypeArtifactSchema = z.looseObject({
  name: z.unknown().optional(),
  purl: z.unknown().optional(),
  version: z.unknown().optional(),
});

function parseGrypeMatches(text: string): NormalizedFinding[] {
  const decoded = safeJsonParse(text);
  if (!decoded.success) throw decoded.error;
  const data = GrypeOutputSchema.safeParse(decoded.data);
  const matches = data.success ? (data.data.matches ?? []) : [];
  const findings: NormalizedFinding[] = [];
  for (const match of matches) {
    const row = GrypeMatchSchema.safeParse(match);
    const vulnerability = GrypeVulnerabilitySchema.safeParse(
      row.success ? row.data.vulnerability : undefined,
    );
    const artifact = GrypeArtifactSchema.safeParse(row.success ? row.data.artifact : undefined);
    const fix = GrypeFixSchema.safeParse(
      vulnerability.success ? vulnerability.data.fix : undefined,
    );
    const versions = fix.success ? (fix.data.versions ?? []) : [];
    findings.push({
      type: "vuln",
      vulnId: scannerString(vulnerability.success ? vulnerability.data.id : undefined),
      severity: normalizeSeverity(
        scannerString(vulnerability.success ? vulnerability.data.severity : undefined),
      ),
      packageName: scannerString(artifact.success ? artifact.data.name : undefined),
      packageVersion: scannerString(artifact.success ? artifact.data.version : undefined),
      purl: scannerString(artifact.success ? artifact.data.purl : undefined),
      fixedVersion: scannerString(versions[0]),
    });
  }
  return findings;
}

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Run Syft (SBOM) + Grype (vuln) over a path, when installed. Returns [] otherwise. */
export async function runGrypeIfAvailable(
  target: string,
  options: ScannerRuntimeOptions = {},
  scanners?: AvailableScanners,
): Promise<NormalizedFinding[]> {
  const resolvedTarget = resolve(target);
  return runScannerAndParse("grype", {
    args: [resolvedTarget, "-o", "json"],
    hostBins: ["grype"],
    image: options.grypeImage ?? DEFAULT_SCANNER_IMAGES.grype,
    options,
    parse: parseGrypeMatches,
    requireOutput: true,
    scanners,
    target: resolvedTarget,
  });
}
