import type { ScannerPlugin } from "@hootifactory/scanner";
import { osvScanDependencies } from "./osv";

export { type OsvScanResult, osvScanDependencies } from "./osv";

const DEFAULT_OSV_API_URL = "https://api.osv.dev";
const TRUTHY = new Set(["1", "true", "yes", "on", "y"]);

interface OsvConfig {
  apiUrl: string;
  /** OSV reaches osv.dev over the network, so it is opt-in via SCANNER_OSV. */
  enabled: boolean;
}

/**
 * OSV.dev batch dependency vulnerability lookup. Network-bound and fail-open
 * (a total OSV outage is treated as "no dependency vulns" but surfaced as an
 * error). Opt-in via `SCANNER_OSV` so a default deployment makes no outbound
 * calls; endpoint overridable via `OSV_API_URL`.
 */
export const osvScanner: ScannerPlugin<OsvConfig> = {
  id: "osv",
  displayName: "OSV.dev",
  scannerVersion: "osv",
  capabilities: {
    inputKind: "dependencies",
    findingTypes: new Set(["vuln"]),
    network: true,
  },
  configFromEnv: (ctx) => ({
    apiUrl: ctx.env.OSV_API_URL?.replace(/\/+$/, "") || DEFAULT_OSV_API_URL,
    enabled: TRUTHY.has((ctx.env.SCANNER_OSV ?? "").trim().toLowerCase()),
  }),
  available: (config) => config.enabled,
  scanDependencies: async (target, config, ctx) => {
    if (!target.ecosystem) return [];
    const result = await osvScanDependencies(target.ecosystem, target.deps, config.apiUrl, {
      timeoutMs: ctx.runtime.timeoutMs,
    });
    // Fail-open but observable: surface a total outage as a fan-out error (empty
    // findings) so the worker can log it, without gating the scan.
    if (result.error !== undefined) throw result.error;
    return result.findings;
  },
};
