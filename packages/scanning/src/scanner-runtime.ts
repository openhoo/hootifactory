import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "@hootifactory/config";
import { BoundedLruCache } from "@hootifactory/core";
import type { ScannerCliRuntime } from "@hootifactory/types";

export interface AvailableScanners {
  syft: boolean;
  grype: boolean;
  trivy: boolean;
  clamav: boolean;
}

export type { ScannerCliRuntime } from "@hootifactory/types";

export interface ScannerRuntimeOptions {
  trivyServerUrl?: string;
  clamavRestUrl?: string;
  cliRuntime?: ScannerCliRuntime;
  timeoutMs?: number;
  dockerCommand?: string;
  dockerMemory?: string;
  dockerCpus?: string;
  dockerPidsLimit?: number;
  dockerStorageSize?: string;
  syftImage?: string;
  grypeImage?: string;
  trivyImage?: string;
  clamavImage?: string;
}

export const DEFAULT_SCANNER_IMAGES = {
  syft: "anchore/syft:latest@sha256:c6d5719f48f5a5986acf2847eb1ed7c53176e712d5721fcd156184cfb262f6eb",
  grype:
    "anchore/grype:latest@sha256:e5b03c0ec0bc20a9eaaf84c2dcc97d9890f4dfb4381fce26bffc7dd8527c3d9d",
  trivy:
    "aquasec/trivy:latest@sha256:016eae51fdcf989332a5404af7e8f625cd5d95d7c0907a221d080a996f556500",
  clamav:
    "clamav/clamav:latest@sha256:d4000290254603e7ee45d4904425c7d98c015af727f402756198fe41a31e7777",
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
    dockerMemory: env.SCANNER_DOCKER_MEMORY,
    dockerCpus: env.SCANNER_DOCKER_CPUS,
    dockerPidsLimit: env.SCANNER_DOCKER_PIDS_LIMIT,
    dockerStorageSize: env.SCANNER_DOCKER_STORAGE_SIZE,
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

const DOCKER_AVAILABLE_CACHE_LIMIT = 16;
let dockerAvailableCache: BoundedLruCache<string, boolean> | null = null;

function hostBinAvailable(bin: string): boolean {
  try {
    return Boolean(Bun.which(bin));
  } catch {
    return false;
  }
}

function dockerAvailable(command = "docker"): boolean {
  dockerAvailableCache ??= new BoundedLruCache(DOCKER_AVAILABLE_CACHE_LIMIT);
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

function dockerScannerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && uid > 0) return `${uid}:${gid ?? uid}`;
  return "65534:65534";
}

export function dockerScannerRunArgs(input: {
  args: string[];
  cidFile?: string;
  entrypoint?: string;
  image: string;
  options?: ScannerRuntimeOptions;
  target: string;
}): string[] {
  const target = resolve(input.target);
  const targetDir = dirname(target);
  const memory = input.options?.dockerMemory ?? "1g";
  const cpus = input.options?.dockerCpus ?? "2";
  const pidsLimit = input.options?.dockerPidsLimit ?? 512;
  const args = [
    "run",
    "--rm",
    "--pull",
    "missing",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--cpus",
    cpus,
    "--pids-limit",
    String(pidsLimit),
    "--ulimit",
    `nproc=${pidsLimit}:${pidsLimit}`,
    "--ulimit",
    "nofile=1024:1024",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
    "--tmpfs",
    "/var/tmp:rw,noexec,nosuid,size=64m,mode=1777",
    "--user",
    dockerScannerUser(),
    "--network",
    "none",
    "--mount",
    `type=bind,source=${targetDir},target=${targetDir},readonly`,
    "--workdir",
    targetDir,
  ];
  if (input.options?.dockerStorageSize) {
    args.push("--storage-opt", `size=${input.options.dockerStorageSize}`);
  }
  if (input.cidFile) args.push("--cidfile", input.cidFile);
  if (input.entrypoint) args.push("--entrypoint", input.entrypoint);
  args.push(input.image, ...input.args);
  return args;
}

async function dockerContainerId(cidFile: string): Promise<string | null> {
  try {
    const id = (await readFile(cidFile, "utf8")).trim();
    return id || null;
  } catch {
    return null;
  }
}

async function cleanupDockerContainer(command: string, cidFile: string): Promise<void> {
  const id = await dockerContainerId(cidFile);
  if (!id) return;
  Bun.spawnSync([command, "kill", id], { stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync([command, "rm", "-f", id], { stdout: "ignore", stderr: "ignore" });
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
  const cidFile = useDocker ? join(tmpdir(), `hootifactory-scan-${randomUUID()}.cid`) : null;
  const args = useDocker
    ? dockerScannerRunArgs({
        args: input.args,
        cidFile: cidFile ?? undefined,
        entrypoint: input.dockerEntryPoint,
        image: input.image,
        options: input.options,
        target,
      })
    : input.args;
  const timeoutMs = input.options.timeoutMs ?? 120_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let timedOut = false;
  signal.addEventListener(
    "abort",
    () => {
      timedOut = true;
      if (cidFile) void cleanupDockerContainer(command, cidFile);
    },
    { once: true },
  );
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  try {
    const text = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (!(input.allowedExitCodes ?? [0]).includes(exitCode)) {
      if (timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms`);
      throw new Error(`${command} exited ${exitCode}: ${stderr.slice(0, 1000)}`);
    }
    return text;
  } catch (err) {
    if (timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    if (cidFile) {
      await cleanupDockerContainer(command, cidFile).catch(() => {});
      await unlink(cidFile).catch(() => {});
    }
  }
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
    scanners?: AvailableScanners;
    target: string;
  },
): Promise<T[]> {
  if (!(input.scanners ?? detectScanners(input.options))[scanner]) return [];
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
