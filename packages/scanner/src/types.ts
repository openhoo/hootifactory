import type { FindingType, NormalizedFinding } from "@hootifactory/scan-core";
import type { ScannerCliRuntime } from "@hootifactory/types";

export type { ScannerCliRuntime } from "@hootifactory/types";

/**
 * What payload a scanner consumes. The orchestrator hands each scanner the shape
 * its `inputKind` declares, so the worker never special-cases a concrete scanner:
 * - `stream`       — fed the artifact byte stream incrementally (signature match).
 * - `content`      — handed a materialized file + a lazy whole-bytes source.
 * - `dependencies` — handed a resolved dependency set extracted by the registry plugin.
 */
export type ScannerInputKind = "stream" | "content" | "dependencies";

export interface ScannerCapabilities {
  /** The payload shape the orchestrator must hand this scanner. */
  inputKind: ScannerInputKind;
  /** The finding types this scanner can emit. */
  findingTypes: ReadonlySet<FindingType>;
  /** Whether the scanner reaches the network at scan time (informational). */
  network: boolean;
}

/**
 * Generic, cross-scanner sandbox/runtime knobs. These carry no per-scanner
 * identity (no image names, no endpoints) — those live in each plugin's own
 * config — so the agnostic runtime can build this once and hand it to every
 * scanner.
 */
export interface ScannerRuntimeOptions {
  cliRuntime?: ScannerCliRuntime;
  timeoutMs?: number;
  dockerCommand?: string;
  dockerMemory?: string;
  dockerCpus?: string;
  dockerPidsLimit?: number;
  dockerStorageSize?: string;
}

/** Context for resolving a scanner's own configuration from the environment. */
export interface ScannerConfigContext {
  /** Environment source (the runtime defaults this to `process.env`). */
  env: Record<string, string | undefined>;
  /** Generic runtime knobs, so a plugin can validate against the active runtime. */
  runtime: ScannerRuntimeOptions;
  /** Whether the process runs in production (gates strict image-pin checks). */
  isProduction: boolean;
}

/** Runtime context passed to availability checks and scan invocations. */
export interface ScannerRunContext {
  runtime: ScannerRuntimeOptions;
}

/** Incremental consumer for `stream`-input scanners (e.g. signature matching). */
export interface ScannerStreamConsumer {
  /** Feed the next chunk of the artifact byte stream. */
  update(chunk: Uint8Array): void;
  /** The findings accumulated after the stream is exhausted. */
  findings(): NormalizedFinding[];
}

/** Materialized payload for `content`-input scanners. */
export interface ContentScanTarget {
  /** A path to the artifact bytes on disk (sandbox-mounted for CLI scanners). */
  path: string;
  /** Lazily read the whole artifact bytes (e.g. to POST to a REST scanner). */
  bytes: () => Promise<Uint8Array>;
}

/** Resolved dependency set for `dependencies`-input scanners. */
export interface DependencyScanTarget {
  ecosystem: string;
  deps: Record<string, string>;
  purlType?: string;
}

/**
 * A self-contained scanner plugin. The agnostic worker discovers these through
 * the {@link ScannerPluginRegistry} and dispatches purely by `capabilities.inputKind`,
 * so adding a scanner never touches the worker. A plugin owns its own
 * configuration (read from the environment in `configFromEnv`) and its own
 * availability probe (`available`); the platform owns streaming, temp files,
 * persistence, and policy.
 *
 * A plugin implements exactly the one scan entry point its `inputKind` selects:
 * `createStreamConsumer` (stream), `scanContent` (content), or `scanDependencies`
 * (dependencies). `register()` asserts the matching entry point is present.
 */
export interface ScannerPlugin<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ScannerCapabilities;
  /**
   * An irreducible, offline, always-available baseline scanner that the operator
   * allowlist (SCANNERS) must NOT be able to disable — it is registered even when
   * an allowlist excludes it. Use for the zero-dependency safety net (signature /
   * advisory scanning) so narrowing the external scanner set never silently drops
   * the baseline malware/vuln gate.
   */
  readonly baseline?: boolean;
  /** Persisted scan provenance (maps to scans.scannerVersion). */
  readonly scannerVersion?: string;
  /** Persisted advisory/db provenance (maps to scans.dbVersion). */
  readonly dbVersion?: string;
  /** Resolve this scanner's own config from the environment. Throws on misconfig. */
  configFromEnv(ctx: ScannerConfigContext): TConfig;
  /** Whether this scanner can actually run now (binary / docker / endpoint reachable). */
  available(config: TConfig, ctx: ScannerRunContext): boolean;
  /**
   * Whether the operator explicitly configured this scanner to use an external
   * runtime/endpoint. Lets the worker stay fail-closed: if external scanning was
   * requested but nothing is available, the scan fails rather than passing on a
   * heuristic-only result. Defaults to false.
   */
  requiresExternalRuntime?(config: TConfig): boolean;
  /** `inputKind: 'stream'` — make a consumer fed the artifact byte stream. */
  createStreamConsumer?(config: TConfig): ScannerStreamConsumer;
  /** `inputKind: 'content'` — scan a materialized artifact file / byte source. */
  scanContent?(
    target: ContentScanTarget,
    config: TConfig,
    ctx: ScannerRunContext,
  ): Promise<NormalizedFinding[]>;
  /** `inputKind: 'dependencies'` — scan a resolved dependency set. */
  scanDependencies?(
    target: DependencyScanTarget,
    config: TConfig,
    ctx: ScannerRunContext,
  ): Promise<NormalizedFinding[]>;
}

/**
 * A registered scanner with its environment-resolved config and a one-shot
 * availability verdict. The runtime resolves these once at startup so the hot
 * scan path never re-probes Docker/host availability.
 */
export interface ResolvedScanner<TConfig = unknown> {
  plugin: ScannerPlugin<TConfig>;
  config: TConfig;
  available: boolean;
}

/** The scanner set as resolved for this process: generic runtime knobs + resolved scanners. */
export interface ScannerRuntime {
  options: ScannerRuntimeOptions;
  scanners: ResolvedScanner[];
}

export type { FindingType, NormalizedFinding };
