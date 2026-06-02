import { resolve } from "node:path";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import {
  DEFAULT_SCANNER_IMAGES,
  runScannerAndParse,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

function parseGrypeMatches(text: string): NormalizedFinding[] {
  const data = JSON.parse(text) as {
    matches?: {
      vulnerability?: { id?: string; severity?: string; fix?: { versions?: string[] } };
      artifact?: { name?: string; version?: string; purl?: string };
    }[];
  };
  return (data.matches ?? []).map((match) => ({
    type: "vuln" as const,
    vulnId: match.vulnerability?.id,
    severity: normalizeSeverity(match.vulnerability?.severity),
    packageName: match.artifact?.name,
    packageVersion: match.artifact?.version,
    purl: match.artifact?.purl,
    fixedVersion: match.vulnerability?.fix?.versions?.[0],
  }));
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
