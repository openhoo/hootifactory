import type { NormalizedFinding } from "@hootifactory/scan-core";
import { runClamAvIfAvailable } from "./clamav";
import { runGrypeIfAvailable } from "./grype";
import {
  type AvailableScanners,
  detectScanners,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";
import { runTrivyIfAvailable } from "./trivy";

export async function runExternalScanners(
  target: string,
  bytes: Uint8Array,
  options: ScannerRuntimeOptions = {},
  scanners: AvailableScanners = detectScanners(options),
): Promise<NormalizedFinding[]> {
  const findings: NormalizedFinding[] = [];
  if (scanners.grype) findings.push(...(await runGrypeIfAvailable(target, options, scanners)));
  if (scanners.trivy) findings.push(...(await runTrivyIfAvailable(target, options, scanners)));
  if (scanners.clamav) {
    findings.push(...(await runClamAvIfAvailable(target, bytes, options, scanners)));
  }
  return findings;
}
