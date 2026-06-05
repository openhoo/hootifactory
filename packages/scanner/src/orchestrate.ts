import type { NormalizedFinding } from "@hootifactory/scan-core";
import type {
  ContentScanTarget,
  DependencyScanTarget,
  ResolvedScanner,
  ScannerConfigContext,
  ScannerPlugin,
  ScannerRunContext,
  ScannerRuntimeOptions,
  ScannerStreamConsumer,
} from "./types";

/** A per-scanner failure during a fan-out; the caller decides how to surface it. */
export interface ScannerFailure {
  scanner: string;
  error: unknown;
}

/**
 * The outcome of fanning a set of scanners out over one payload. `attempted`
 * names every scanner that ran, so a caller can stay fail-closed by detecting the
 * all-failed case (`attempted.length > 0 && errors.length === attempted.length`).
 */
export interface ScannerFanoutResult {
  findings: NormalizedFinding[];
  errors: ScannerFailure[];
  attempted: string[];
}

/**
 * Resolve every registered scanner's own config from the environment and probe its
 * availability — once, at startup. `configFromEnv` runs here, so a plugin's
 * startup-time validation (e.g. requiring a digest-pinned image in production)
 * surfaces as a boot failure exactly like the old central env schema did.
 */
export function resolveScanners(
  plugins: ScannerPlugin[],
  ctx: {
    env: Record<string, string | undefined>;
    runtime: ScannerRuntimeOptions;
    isProduction: boolean;
  },
): ResolvedScanner[] {
  const configContext: ScannerConfigContext = {
    env: ctx.env,
    runtime: ctx.runtime,
    isProduction: ctx.isProduction,
  };
  return plugins.map((plugin) => {
    const config = plugin.configFromEnv(configContext);
    return { plugin, config, available: plugin.available(config, { runtime: ctx.runtime }) };
  });
}

/** Make one consumer per available `stream`-input scanner over the artifact byte stream. */
export function streamConsumersFor(scanners: ResolvedScanner[]): {
  scanner: ResolvedScanner;
  consumer: ScannerStreamConsumer;
}[] {
  const consumers: { scanner: ResolvedScanner; consumer: ScannerStreamConsumer }[] = [];
  for (const scanner of scanners) {
    if (!scanner.available || scanner.plugin.capabilities.inputKind !== "stream") continue;
    if (!scanner.plugin.createStreamConsumer) continue;
    consumers.push({ scanner, consumer: scanner.plugin.createStreamConsumer(scanner.config) });
  }
  return consumers;
}

/** Fan the available `content`-input scanners out over a materialized artifact. */
export function runContentScanners(
  scanners: ResolvedScanner[],
  target: ContentScanTarget,
  ctx: ScannerRunContext,
): Promise<ScannerFanoutResult> {
  return fanOut(
    scanners.filter((s) => s.available && s.plugin.capabilities.inputKind === "content"),
    (s) => s.plugin.scanContent?.(target, s.config, ctx) ?? Promise.resolve([]),
  );
}

/** Fan the available `dependencies`-input scanners out over a resolved dependency set. */
export function runDependencyScanners(
  scanners: ResolvedScanner[],
  target: DependencyScanTarget,
  ctx: ScannerRunContext,
): Promise<ScannerFanoutResult> {
  return fanOut(
    scanners.filter((s) => s.available && s.plugin.capabilities.inputKind === "dependencies"),
    (s) => s.plugin.scanDependencies?.(target, s.config, ctx) ?? Promise.resolve([]),
  );
}

/**
 * Run `scanners` concurrently and tolerate individual failures: a flaky scanner is
 * reported in `errors` instead of discarding the findings the healthy scanners
 * already produced.
 */
async function fanOut(
  scanners: ResolvedScanner[],
  run: (scanner: ResolvedScanner) => Promise<NormalizedFinding[]>,
): Promise<ScannerFanoutResult> {
  const findings: NormalizedFinding[] = [];
  const errors: ScannerFailure[] = [];
  const attempted: string[] = [];
  await Promise.all(
    scanners.map(async (scanner) => {
      attempted.push(scanner.plugin.id);
      try {
        findings.push(...(await run(scanner)));
      } catch (error) {
        errors.push({ scanner: scanner.plugin.id, error });
      }
    }),
  );
  return { findings, errors, attempted };
}
