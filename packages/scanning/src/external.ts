import type { NormalizedFinding } from "@hootifactory/scan-core";
import { runClamAvIfAvailable } from "./clamav";
import { runGrypeIfAvailable } from "./grype";
import { detectScanners, type ScannerRuntimeOptions } from "./scanner-runtime";
import { runTrivyIfAvailable } from "./trivy";

export async function runExternalScanners(
  target: string,
  bytes: Uint8Array,
  options: ScannerRuntimeOptions = {},
): Promise<NormalizedFinding[]> {
  const scanners = detectScanners(options);
  const findings: NormalizedFinding[] = [];
  if (scanners.grype) findings.push(...(await runGrypeIfAvailable(target, options)));
  if (scanners.trivy) findings.push(...(await runTrivyIfAvailable(target, options)));
  if (scanners.clamav) {
    findings.push(...(await runClamAvIfAvailable(target, bytes, options)));
  }
  return findings;
}
