import type { ScannerPlugin } from "@hootifactory/scanner";
import {
  ADVISORIES,
  type Advisory,
  isVersionVulnerable,
  scanDependenciesAgainstAdvisories,
} from "./advisories";
import { createMalwareStreamConsumer, scanForMalware } from "./malware";

export {
  ADVISORIES,
  type Advisory,
  createMalwareStreamConsumer,
  isVersionVulnerable,
  scanDependenciesAgainstAdvisories,
  scanForMalware,
};

/**
 * Offline, deterministic dependency advisory scan. Always available (no external
 * runtime), so a zero-config / heuristic-only deployment still flags known-bad
 * dependencies. Supplemented by Grype/Trivy/OSV when those are configured.
 */
export const heuristicDependencyScanner: ScannerPlugin<null> = {
  id: "heuristic-deps",
  displayName: "Hootifactory advisory scanner",
  baseline: true,
  scannerVersion: "1",
  dbVersion: "builtin",
  capabilities: {
    inputKind: "dependencies",
    findingTypes: new Set(["vuln"]),
    network: false,
  },
  configFromEnv: () => null,
  available: () => true,
  scanDependencies: (target) =>
    Promise.resolve(scanDependenciesAgainstAdvisories(target.deps, { purlType: target.purlType })),
};

/**
 * Offline malware signature scan (EICAR). Always available and streamed, so it
 * runs over every artifact's bytes without buffering — the always-on baseline
 * that keeps malware gating working even when no external scanner is configured.
 */
export const heuristicMalwareScanner: ScannerPlugin<null> = {
  id: "heuristic-malware",
  displayName: "Hootifactory signature scanner",
  baseline: true,
  scannerVersion: "1",
  dbVersion: "builtin",
  capabilities: {
    inputKind: "stream",
    findingTypes: new Set(["malware"]),
    network: false,
  },
  configFromEnv: () => null,
  available: () => true,
  createStreamConsumer: () => createMalwareStreamConsumer(),
};
