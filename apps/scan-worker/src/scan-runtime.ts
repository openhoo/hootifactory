import {
  type AvailableScanners,
  detectScanners,
  type ScannerRuntimeOptions,
  scannerOptionsFromEnv,
} from "@hootifactory/scanning";

export function externalContentScannerRequired(options: ScannerRuntimeOptions): boolean {
  return (
    Boolean(options.clamavRestUrl) ||
    Boolean(options.trivyServerUrl) ||
    (options.cliRuntime ?? "docker") !== "disabled"
  );
}

export function externalContentScannerAvailable(scanners: AvailableScanners): boolean {
  return scanners.grype || scanners.trivy || scanners.clamav;
}

export function shouldFailForMissingExternalScanner(
  options: ScannerRuntimeOptions,
  scanners: AvailableScanners,
): boolean {
  return externalContentScannerRequired(options) && !externalContentScannerAvailable(scanners);
}

export interface ScannerRuntime {
  scannerOptions: ScannerRuntimeOptions;
  scanners: AvailableScanners;
}

export function scannerRuntimeFromEnv(): ScannerRuntime {
  const scannerOptions = scannerOptionsFromEnv();
  return { scannerOptions, scanners: detectScanners(scannerOptions) };
}

export function unavailableExternalScannerMessage(options: ScannerRuntimeOptions): string {
  return [
    "external scanner runtime is configured but no content scanner is available",
    `(SCANNER_CLI_RUNTIME=${options.cliRuntime ?? "docker"})`,
    "set SCANNER_CLI_RUNTIME=disabled for heuristic-only scanning or configure Grype, Trivy, or ClamAV",
  ].join("; ");
}
