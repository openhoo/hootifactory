import type {
  ContentScanTarget,
  DependencyScanTarget,
  ResolvedScanner,
  ScannerPlugin,
  ScannerRunContext,
  ScannerRuntimeOptions,
} from "../types";

/** Generic runtime options for tests (host runtime so nothing reaches Docker). */
export function createTestScannerRuntimeOptions(
  overrides: Partial<ScannerRuntimeOptions> = {},
): ScannerRuntimeOptions {
  return { cliRuntime: "host", timeoutMs: 5_000, ...overrides };
}

export function createTestScannerRunContext(
  overrides: Partial<ScannerRuntimeOptions> = {},
): ScannerRunContext {
  return { runtime: createTestScannerRuntimeOptions(overrides) };
}

/** A content scan target backed by an in-memory byte buffer. */
export function createTestContentTarget(
  bytes: Uint8Array,
  path = "/tmp/hootifactory-test-artifact",
): ContentScanTarget {
  return { path, bytes: () => Promise.resolve(bytes) };
}

export function createTestDependencyTarget(
  deps: Record<string, string>,
  overrides: Partial<DependencyScanTarget> = {},
): DependencyScanTarget {
  return { ecosystem: "npm", deps, ...overrides };
}

/** Resolve a single plugin for tests (config from the given env, default empty). */
export function resolveTestScanner<TConfig>(
  plugin: ScannerPlugin<TConfig>,
  options: {
    env?: Record<string, string | undefined>;
    runtime?: Partial<ScannerRuntimeOptions>;
    isProduction?: boolean;
  } = {},
): ResolvedScanner<TConfig> {
  const runtime = createTestScannerRuntimeOptions(options.runtime);
  const config = plugin.configFromEnv({
    env: options.env ?? {},
    runtime,
    isProduction: options.isProduction ?? false,
  });
  return { plugin, config, available: plugin.available(config, { runtime }) };
}
