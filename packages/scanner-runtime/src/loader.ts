import { env, isProduction } from "@hootifactory/config";
import {
  resolveScanners,
  type ScannerPlugin,
  type ScannerPluginRegistry,
  type ScannerRuntime,
  type ScannerRuntimeOptions,
  scannerPlugins,
} from "@hootifactory/scanner";
import { SCANNER_MANIFEST } from "./manifest";

export interface LoadScannersResult {
  /** Scanner ids registered into the registry. */
  registered: string[];
  /** Allowlist entries that matched no manifest scanner (operator typos). */
  unknown: string[];
}

/**
 * Register the built-in scanners into `registry`, filtered by the operator
 * allowlist. An unset allowlist (the default) registers the whole manifest, so a
 * zero-config deployment scans with everything available; `SCANNERS=grype,osv`
 * narrows the set without a code change. Returns the registered ids plus any
 * allowlist entries that matched nothing, so the caller can warn on typos.
 */
export function loadConfiguredScanners(
  registry: ScannerPluginRegistry = scannerPlugins,
  options: { enabled?: readonly string[] } = {},
): LoadScannersResult {
  const enabled = options.enabled ?? env.SCANNERS;
  const allowed = enabled ? new Set(enabled) : null;
  const manifestIds = new Set(SCANNER_MANIFEST.map((plugin) => plugin.id));
  const registered: string[] = [];
  for (const plugin of selectScanners(allowed)) {
    if (registry.has(plugin.id)) continue;
    registry.register(plugin);
    registered.push(plugin.id);
  }
  const unknown = allowed ? [...allowed].filter((id) => !manifestIds.has(id)) : [];
  return { registered, unknown };
}

function selectScanners(allowed: Set<string> | null): ScannerPlugin[] {
  if (!allowed) return SCANNER_MANIFEST;
  // The offline baseline scanners are irreducible: the allowlist narrows the
  // optional/external set but can never disable the always-on malware/advisory
  // gate (matching the pre-plugin behavior where the heuristic scan always ran).
  return SCANNER_MANIFEST.filter((plugin) => plugin.baseline || allowed.has(plugin.id));
}

/** Build the generic, cross-scanner runtime knobs from the environment. */
export function scannerRuntimeOptionsFromEnv(): ScannerRuntimeOptions {
  return {
    cliRuntime: env.SCANNER_CLI_RUNTIME,
    timeoutMs: env.SCANNER_TIMEOUT_MS,
    maxOutputBytes: env.SCANNER_MAX_OUTPUT_BYTES,
    dockerCommand: env.SCANNER_DOCKER_COMMAND,
    dockerMemory: env.SCANNER_DOCKER_MEMORY,
    dockerCpus: env.SCANNER_DOCKER_CPUS,
    dockerPidsLimit: env.SCANNER_DOCKER_PIDS_LIMIT,
    dockerStorageSize: env.SCANNER_DOCKER_STORAGE_SIZE,
  };
}

/**
 * Resolve every registered scanner's config + availability once, against the
 * process environment. The returned runtime is what the worker hands to the
 * generic fan-out helpers.
 */
export function createScannerRuntime(
  registry: ScannerPluginRegistry = scannerPlugins,
): ScannerRuntime {
  const options = scannerRuntimeOptionsFromEnv();
  return {
    options,
    scanners: resolveScanners(registry.all(), {
      env: process.env,
      runtime: options,
      isProduction,
    }),
  };
}
