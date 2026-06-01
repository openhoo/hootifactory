import { resolve } from "node:path";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import {
  DEFAULT_SCANNER_IMAGES,
  detectScanners,
  runScannerCli,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

/** Run Syft (SBOM) + Grype (vuln) over a path, when installed. Returns [] otherwise. */
export async function runGrypeIfAvailable(
  target: string,
  options: ScannerRuntimeOptions = {},
): Promise<NormalizedFinding[]> {
  if (!detectScanners(options).grype) return [];
  const resolvedTarget = resolve(target);
  const text = await runScannerCli({
    args: [resolvedTarget, "-o", "json"],
    hostBins: ["grype"],
    image: options.grypeImage ?? DEFAULT_SCANNER_IMAGES.grype,
    options,
    target: resolvedTarget,
  });
  if (!text) throw new Error("grype produced no output");
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
