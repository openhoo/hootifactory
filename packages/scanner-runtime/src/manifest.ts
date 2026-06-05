import type { ScannerPlugin } from "@hootifactory/scanner";
import { clamavScanner } from "@hootifactory/scanner-clamav";
import { grypeScanner } from "@hootifactory/scanner-grype";
import {
  heuristicDependencyScanner,
  heuristicMalwareScanner,
} from "@hootifactory/scanner-heuristic";
import { osvScanner } from "@hootifactory/scanner-osv";
import { trivyScanner } from "@hootifactory/scanner-trivy";

/**
 * The built-in scanner set — the single place that names concrete scanner
 * packages. Discovery is static (so the bundler/Docker see every import and the
 * dependency graph stays frozen); the operator allowlist (SCANNERS) selects which
 * of these to register at startup. Adding a scanner is one import + one line here,
 * never a change to the worker.
 */
export const SCANNER_MANIFEST: ScannerPlugin[] = [
  heuristicMalwareScanner,
  heuristicDependencyScanner,
  grypeScanner,
  trivyScanner,
  clamavScanner,
  osvScanner,
];
