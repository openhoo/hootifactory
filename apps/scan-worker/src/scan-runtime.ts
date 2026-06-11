import { logger } from "@hootifactory/observability";
import {
  type ResolvedScanner,
  type ScannerRuntime,
  type ScannerRuntimeOptions,
  usesDocker,
} from "@hootifactory/scanner";
import { createScannerRuntime } from "@hootifactory/scanner-runtime";

export type { ScannerRuntime } from "@hootifactory/scanner";

/**
 * Whether CLI scanners would execute directly on the host instead of inside the
 * hardened Docker sandbox: `SCANNER_CLI_RUNTIME=host`, or `auto` without a
 * reachable Docker daemon.
 */
export function scannerCliRunsOnHost(options: ScannerRuntimeOptions): boolean {
  const cliRuntime = options.cliRuntime ?? "docker";
  if (cliRuntime === "host") return true;
  if (cliRuntime === "auto") return !usesDocker(options);
  return false;
}

/**
 * The operator-facing warning for an unsandboxed scanner runtime, or null when
 * CLI scanners run sandboxed (or not at all). Host mode applies none of the
 * Docker hardening — no network isolation, read-only filesystem, cap drops, or
 * memory/pids caps; only the scan timeout bounds a scanner run — so a malicious
 * artifact exercises scanner binaries with the worker's full privileges.
 */
export function unsandboxedScannerRuntimeWarning(options: ScannerRuntimeOptions): string | null {
  if (!scannerCliRunsOnHost(options)) return null;
  return [
    "scanner CLI runtime resolves to host: scanner binaries run unsandboxed on this machine",
    "(no network/filesystem/capability/memory isolation; only SCANNER_TIMEOUT_MS applies)",
    "use SCANNER_CLI_RUNTIME=docker (or auto with a reachable Docker daemon) in production",
  ].join("; ");
}

let warnedUnsandboxedRuntime = false;

/**
 * Resolve every registered scanner's config + availability against the
 * environment. Warns once per process when the resolved CLI runtime is
 * unsandboxed host execution — always, not only in production: the trade-off is
 * otherwise invisible, the line is emitted once, and a dev environment running
 * host mode should surface the same signal operators will see in production.
 */
export function scannerRuntimeFromEnv(): ScannerRuntime {
  const runtime = createScannerRuntime();
  const warning = unsandboxedScannerRuntimeWarning(runtime.options);
  if (warning && !warnedUnsandboxedRuntime) {
    warnedUnsandboxedRuntime = true;
    logger.warn(warning, { cliRuntime: runtime.options.cliRuntime ?? "docker" });
  }
  return runtime;
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
