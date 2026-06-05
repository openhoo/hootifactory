import type { NormalizedFinding } from "@hootifactory/scan-core";
import { runClamAvIfAvailable, type ScannerByteSource } from "./clamav";
import { runGrypeIfAvailable } from "./grype";
import {
  type AvailableScanners,
  detectScanners,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";
import { runTrivyIfAvailable } from "./trivy";

export interface ExternalScannerError {
  scanner: string;
  error: unknown;
}

export interface ExternalScanResult {
  findings: NormalizedFinding[];
  /** Per-scanner failures; the caller decides how to surface and whether to fail. */
  errors: ExternalScannerError[];
  /** How many scanners were actually attempted (available and run). */
  attempted: number;
}

/**
 * Fans the available external scanners out concurrently and tolerates individual
 * failures: a flaky scanner is reported in `errors` instead of discarding the
 * findings the healthy scanners already produced. Deciding fail-open vs
 * fail-closed is the caller's job — `attempted` lets it detect the all-failed
 * case (every attempted scanner errored) and keep the scan gate fail-closed.
 */
export async function runExternalScanners(
  target: string,
  bytes?: ScannerByteSource,
  options: ScannerRuntimeOptions = {},
  scanners: AvailableScanners = detectScanners(options),
): Promise<ExternalScanResult> {
  const tasks: { scanner: string; run: Promise<NormalizedFinding[]> }[] = [];
  if (scanners.grype)
    tasks.push({ scanner: "grype", run: runGrypeIfAvailable(target, options, scanners) });
  if (scanners.trivy)
    tasks.push({ scanner: "trivy", run: runTrivyIfAvailable(target, options, scanners) });
  if (scanners.clamav) {
    tasks.push({ scanner: "clamav", run: runClamAvIfAvailable(target, bytes, options, scanners) });
  }

  const results = await Promise.all(
    tasks.map(
      async (
        task,
      ): Promise<
        { scanner: string; findings: NormalizedFinding[] } | { scanner: string; error: unknown }
      > => {
        try {
          return { scanner: task.scanner, findings: await task.run };
        } catch (error) {
          return { scanner: task.scanner, error };
        }
      },
    ),
  );

  const findings: NormalizedFinding[] = [];
  const errors: ExternalScannerError[] = [];
  for (const result of results) {
    if ("findings" in result) findings.push(...result.findings);
    else errors.push({ scanner: result.scanner, error: result.error });
  }
  return { findings, errors, attempted: tasks.length };
}
