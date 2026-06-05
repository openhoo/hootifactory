import type { ResolvedScanner, ScannerRuntime } from "@hootifactory/scanner";
import { createScannerRuntime } from "@hootifactory/scanner-runtime";

export type { ScannerRuntime } from "@hootifactory/scanner";

/** Resolve every registered scanner's config + availability against the environment. */
export function scannerRuntimeFromEnv(): ScannerRuntime {
  return createScannerRuntime();
}

function contentScanners(runtime: ScannerRuntime): ResolvedScanner[] {
  return runtime.scanners.filter((s) => s.plugin.capabilities.inputKind === "content");
}

/** Whether any content (byte/file) scanner can actually run. */
export function externalContentScannerAvailable(runtime: ScannerRuntime): boolean {
  return contentScanners(runtime).some((s) => s.available);
}

/**
 * Whether the operator intends external content scanning — either the CLI runtime
 * is enabled, or a content scanner was explicitly pointed at an endpoint. Lets the
 * worker stay fail-closed when external scanning was requested but is unavailable.
 */
export function externalContentScannerRequested(runtime: ScannerRuntime): boolean {
  if ((runtime.options.cliRuntime ?? "docker") !== "disabled") return true;
  return contentScanners(runtime).some(
    (s) => s.plugin.requiresExternalRuntime?.(s.config) ?? false,
  );
}

export function shouldFailForMissingExternalScanner(runtime: ScannerRuntime): boolean {
  return externalContentScannerRequested(runtime) && !externalContentScannerAvailable(runtime);
}

export function unavailableExternalScannerMessage(runtime: ScannerRuntime): string {
  const names = contentScanners(runtime)
    .map((s) => s.plugin.displayName)
    .join(", ");
  return [
    "external content scanning is configured but no content scanner is available",
    `(SCANNER_CLI_RUNTIME=${runtime.options.cliRuntime ?? "docker"})`,
    `set SCANNER_CLI_RUNTIME=disabled for heuristic-only scanning or make a content scanner available${
      names ? ` (${names})` : ""
    }`,
  ].join("; ");
}
