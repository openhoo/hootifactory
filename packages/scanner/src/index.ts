// Re-export the shared primitives a scanner plugin needs, so a plugin depends on
// the scanner SDK alone (mirroring how registry plugins lean on their own SDK).
export {
  BoundedLruCache,
  safeJsonParse,
  stripTrailingSlashes,
  type ZodType,
  z,
} from "@hootifactory/core";
export {
  asRecord,
  asString,
  asStringRecord,
  type FindingType,
  maxSeverity,
  type NormalizedFinding,
  normalizeSeverity,
  SEVERITY_ORDER,
  type Severity,
} from "@hootifactory/scan-core";
export {
  resolveScanners,
  runContentScanners,
  runDependencyScanners,
  type ScannerFailure,
  type ScannerFanoutResult,
  streamConsumersFor,
} from "./orchestrate";
export { ScannerPluginRegistry, scannerPlugins } from "./registry";
export {
  assertDigestPinnedImage,
  dockerAvailable,
  dockerScannerRunArgs,
  hostBinAvailable,
  isDigestPinnedImage,
  runCliScanner,
  runScannerCli,
  scannerCliAvailable,
  usesDocker,
} from "./runtime";
export type {
  ContentScanTarget,
  DependencyScanTarget,
  ResolvedScanner,
  ScannerCapabilities,
  ScannerCliRuntime,
  ScannerConfigContext,
  ScannerInputKind,
  ScannerPlugin,
  ScannerRunContext,
  ScannerRuntime,
  ScannerRuntimeOptions,
  ScannerStreamConsumer,
} from "./types";
