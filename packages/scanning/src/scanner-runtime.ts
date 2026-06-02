import { dirname, resolve } from "node:path";
import { env } from "@hootifactory/config";

export interface AvailableScanners {
  syft: boolean;
  grype: boolean;
  trivy: boolean;
  clamav: boolean;
}

export type ScannerCliRuntime = "auto" | "docker" | "host" | "disabled";

export interface ScannerRuntimeOptions {
  trivyServerUrl?: string;
  clamavRestUrl?: string;
  cliRuntime?: ScannerCliRuntime;
  timeoutMs?: number;
  dockerCommand?: string;
  syftImage?: string;
  grypeImage?: string;
  trivyImage?: string;
  clamavImage?: string;
}

export const DEFAULT_SCANNER_IMAGES = {
  syft: "anchore/syft:latest",
  grype: "anchore/grype:latest",
  trivy: "aquasec/trivy:latest",
  clamav: "clamav/clamav:latest",
} as const;

/** Build the runtime scanner options from the process environment. */
export function scannerOptionsFromEnv(): ScannerRuntimeOptions {
  return {
    clamavImage: env.CLAMAV_IMAGE,
    trivyServerUrl: env.TRIVY_SERVER_URL,
    clamavRestUrl: env.CLAMAV_REST_URL,
    cliRuntime: env.SCANNER_CLI_RUNTIME,
    timeoutMs: env.SCANNER_TIMEOUT_MS,
    dockerCommand: env.SCANNER_DOCKER_COMMAND,
    grypeImage: env.GRYPE_IMAGE,
    syftImage: env.SYFT_IMAGE,
    trivyImage: env.TRIVY_IMAGE,
  };
}

/**
 * Normalize a legacy `string | ScannerRuntimeOptions` argument: a bare string is
 * treated as the value for `stringKey`, otherwise the options object (or `{}`).
 */
type StringScannerOptionKey = {
  [K in keyof ScannerRuntimeOptions]-?: NonNullable<ScannerRuntimeOptions[K]> extends string
    ? K
    : never;
}[keyof ScannerRuntimeOptions];

export function coerceScannerOptions(
  arg: string | ScannerRuntimeOptions | undefined,
  stringKey: StringScannerOptionKey,
): ScannerRuntimeOptions {
  return typeof arg === "string" ? { [stringKey]: arg } : (arg ?? {});
}

let dockerAvailableCache: Map<string, boolean> | null = null;

function hostBinAvailable(bin: string): boolean {
  try {
    return Boolean(Bun.which(bin));
  } catch {
    return false;
  }
}

function dockerAvailable(command = "docker"): boolean {
  dockerAvailableCache ??= new Map();
  const cached = dockerAvailableCache.get(command);
  if (cached !== undefined) return cached;
  if (!hostBinAvailable(command)) {
    dockerAvailableCache.set(command, false);
    return false;
  }
  try {
    const proc = Bun.spawnSync([command, "info"], { stdout: "ignore", stderr: "ignore" });
    const ok = proc.exitCode === 0;
    dockerAvailableCache.set(command, ok);
    return ok;
  } catch {
    dockerAvailableCache.set(command, false);
    return false;
  }
}

function cliRuntime(options: ScannerRuntimeOptions): ScannerCliRuntime {
  return options.cliRuntime ?? "docker";
}

function scannerCliAvailable(hostBins: string[], options: ScannerRuntimeOptions): boolean {
  const runtime = cliRuntime(options);
  if (runtime === "disabled") return false;
  if (runtime === "docker") return dockerAvailable(options.dockerCommand);
  if (runtime === "host") return hostBins.some(hostBinAvailable);
  return dockerAvailable(options.dockerCommand) || hostBins.some(hostBinAvailable);
}

function shouldUseDocker(options: ScannerRuntimeOptions): boolean {
  const runtime = cliRuntime(options);
  if (runtime === "docker") return true;
  if (runtime === "auto") return dockerAvailable(options.dockerCommand);
  if (runtime === "host") return false;
  return false;
}

export function dockerScannerRunArgs(input: {
  args: string[];
  entrypoint?: string;
  image: string;
  target: string;
}): string[] {
  const target = resolve(input.target);
  const targetDir = dirname(target);
  const args = [
    "run",
    "--rm",
    "--pull",
    "missing",
    "--mount",
    `type=bind,source=${targetDir},target=${targetDir},readonly`,
    "--workdir",
    targetDir,
  ];
  if (process.platform === "linux") {
    args.push("--network", "host");
  } else {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }
  if (input.entrypoint) args.push("--entrypoint", input.entrypoint);
  args.push(input.image, ...input.args);
  return args;
}

export async function runScannerCli(input: {
  args: string[];
  allowedExitCodes?: number[];
  dockerEntryPoint?: string;
  hostBins: string[];
  image: string;
  options: ScannerRuntimeOptions;
  target: string;
}): Promise<string | null> {
  const target = resolve(input.target);
  const useDocker = shouldUseDocker(input.options);
  const command = useDocker
    ? (input.options.dockerCommand ?? "docker")
    : input.hostBins.find(hostBinAvailable);
  if (!command) return null;
  const args = useDocker
    ? dockerScannerRunArgs({
        args: input.args,
        entrypoint: input.dockerEntryPoint,
        image: input.image,
        target,
      })
    : input.args;
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(input.options.timeoutMs ?? 120_000),
  });
  const text = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (!(input.allowedExitCodes ?? [0]).includes(exitCode)) {
    throw new Error(`${command} exited ${exitCode}: ${stderr.slice(0, 1000)}`);
  }
  return text;
}

/**
 * Run a CLI scanner over a target and parse its output, when the scanner is available.
 * Returns `[]` when the scanner is unavailable. When `requireOutput` is true and the
 * scanner produced no output, throws `${scanner} produced no output`; otherwise empty
 * output yields `[]`.
 */
export async function runScannerAndParse<T>(
  scanner: keyof AvailableScanners,
  input: {
    args: string[];
    allowedExitCodes?: number[];
    dockerEntryPoint?: string;
    hostBins: string[];
    image: string;
    options: ScannerRuntimeOptions;
    parse: (text: string) => T[];
    requireOutput?: boolean;
    target: string;
  },
): Promise<T[]> {
  if (!detectScanners(input.options)[scanner]) return [];
  const resolvedTarget = resolve(input.target);
  const text = await runScannerCli({
    args: input.args,
    allowedExitCodes: input.allowedExitCodes,
    dockerEntryPoint: input.dockerEntryPoint,
    hostBins: input.hostBins,
    image: input.image,
    options: input.options,
    target: resolvedTarget,
  });
  if (!text) {
    if (input.requireOutput) throw new Error(`${scanner} produced no output`);
    return [];
  }
  return input.parse(text);
}

/** Detect which external scanner clients can be run. Docker-backed clients are the default. */
export function detectScanners(options: ScannerRuntimeOptions = {}): AvailableScanners {
  return {
    syft: scannerCliAvailable(["syft"], options),
    grype: scannerCliAvailable(["grype"], options),
    trivy: scannerCliAvailable(["trivy"], options),
    clamav:
      Boolean(options.clamavRestUrl) || scannerCliAvailable(["clamdscan", "clamscan"], options),
  };
}
