import type { NormalizedFinding } from "@hootifactory/scan-core";
import { runClamAvIfAvailable, type ScannerByteSource } from "./clamav";
import { runGrypeIfAvailable } from "./grype";
import {
  type AvailableScanners,
  detectScanners,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";
import { runTrivyIfAvailable } from "./trivy";

export async function runExternalScanners(
  target: string,
  bytes?: ScannerByteSource,
  options: ScannerRuntimeOptions = {},
  scanners: AvailableScanners = detectScanners(options),
): Promise<NormalizedFinding[]> {
  const tasks: Promise<NormalizedFinding[]>[] = [];
  if (scanners.grype) tasks.push(runGrypeIfAvailable(target, options, scanners));
  if (scanners.trivy) tasks.push(runTrivyIfAvailable(target, options, scanners));
  if (scanners.clamav) {
    tasks.push(runClamAvIfAvailable(target, bytes, options, scanners));
  }
  return (await Promise.all(tasks)).flat();
}
