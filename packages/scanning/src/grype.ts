import { resolve } from "node:path";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import { asRecord, asString } from "./scanner-json";
import {
  DEFAULT_SCANNER_IMAGES,
  runScannerAndParse,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

function parseGrypeMatches(text: string): NormalizedFinding[] {
  const data = asRecord(JSON.parse(text));
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  const findings: NormalizedFinding[] = [];
  for (const match of matches) {
    const row = asRecord(match);
    const vulnerability = asRecord(row?.vulnerability);
    const artifact = asRecord(row?.artifact);
    const fix = asRecord(vulnerability?.fix);
    const versions = Array.isArray(fix?.versions) ? fix.versions : [];
    findings.push({
      type: "vuln",
      vulnId: asString(vulnerability?.id),
      severity: normalizeSeverity(asString(vulnerability?.severity)),
      packageName: asString(artifact?.name),
      packageVersion: asString(artifact?.version),
      purl: asString(artifact?.purl),
      fixedVersion: asString(versions[0]),
    });
  }
  return findings;
}

/** Run Syft (SBOM) + Grype (vuln) over a path, when installed. Returns [] otherwise. */
export async function runGrypeIfAvailable(
  target: string,
  options: ScannerRuntimeOptions = {},
): Promise<NormalizedFinding[]> {
  const resolvedTarget = resolve(target);
  return runScannerAndParse("grype", {
    args: [resolvedTarget, "-o", "json"],
    hostBins: ["grype"],
    image: options.grypeImage ?? DEFAULT_SCANNER_IMAGES.grype,
    options,
    parse: parseGrypeMatches,
    requireOutput: true,
    target: resolvedTarget,
  });
}
