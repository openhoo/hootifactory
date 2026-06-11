import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BoundedLruCache } from "@hootifactory/core";
import type { ScannerConfigContext, ScannerRuntimeOptions } from "./types";

const DOCKER_AVAILABLE_CACHE_LIMIT = 16;
let dockerAvailableCache: BoundedLruCache<string, boolean> | null = null;

/** Whether a host binary is on PATH. */
export function hostBinAvailable(bin: string): boolean {
  try {
    return Boolean(Bun.which(bin));
  } catch {
    return false;
  }
}

/** Whether a Docker-compatible CLI is installed and its daemon reachable (cached). */
export function dockerAvailable(command = "docker"): boolean {
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

function cliRuntime(
  options: ScannerRuntimeOptions,
): NonNullable<ScannerRuntimeOptions["cliRuntime"]> {
  return options.cliRuntime ?? "docker";
}

/**
 * Whether a CLI scanner backed by `hostBins` (or a Docker image) can run under the
 * configured runtime. Plugins use this to implement `available()` without knowing
 * the runtime-selection rules.
 */
export function scannerCliAvailable(hostBins: string[], options: ScannerRuntimeOptions): boolean {
  const runtime = cliRuntime(options);
  if (runtime === "disabled") return false;
  if (runtime === "docker") return dockerAvailable(options.dockerCommand);
  if (runtime === "host") return hostBins.some(hostBinAvailable);
  return dockerAvailable(options.dockerCommand) || hostBins.some(hostBinAvailable);
}

/** Whether the configured runtime resolves to Docker (vs. a host binary). */
export function usesDocker(options: ScannerRuntimeOptions): boolean {
  const runtime = cliRuntime(options);
  if (runtime === "docker") return true;
  if (runtime === "auto") return dockerAvailable(options.dockerCommand);
  return false;
}

function dockerScannerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && uid > 0) return `${uid}:${gid ?? uid}`;
  return "65534:65534";
}

/** Build a hardened `docker run` argv that mounts only the target directory read-only. */
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

/**
 * Run a sandboxed CLI scanner (Docker or host binary) over `target` and return its
 * stdout, or `null` when no runtime is available. Enforces a timeout and reaps the
 * Docker container on abort.
 */
/** Default ceiling for scanner stdout (a crafted artifact can make a scanner emit unbounded JSON). */
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** stderr is only quoted in error messages, so a small excerpt suffices. */
const MAX_STDERR_BYTES = 1024 * 1024;

/**
 * Read a stream fully up to `maxBytes`. Past the ceiling the stream is
 * cancelled and `truncated` is set so the caller can fail the scan instead of
 * buffering attacker-controlled output into worker memory.
 */
async function readStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), truncated };
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
  const useDocker = usesDocker(input.options);
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
  const maxOutputBytes = input.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  try {
    // Drain both pipes concurrently (a child filling the un-drained stderr pipe
    // would otherwise block until the timeout) and cap how much output is
    // buffered into worker memory.
    const [out, errOut] = await Promise.all([
      readStreamBounded(proc.stdout, maxOutputBytes),
      readStreamBounded(proc.stderr, MAX_STDERR_BYTES),
    ]);
    if (out.truncated) {
      proc.kill();
      throw new Error(`${command} produced more than ${maxOutputBytes} bytes of output`);
    }
    const exitCode = await proc.exited;
    if (!(input.allowedExitCodes ?? [0]).includes(exitCode)) {
      if (timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms`);
      throw new Error(`${command} exited ${exitCode}: ${errOut.text.slice(0, 1000)}`);
    }
    return out.text;
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
 * Run a CLI scanner over a target and parse its output. Returns `[]` when no
 * runtime is available. When `requireOutput` is true and the scanner produced no
 * output, throws `${label} produced no output`; otherwise empty output yields `[]`.
 *
 * Availability is the caller's concern: the orchestrator only invokes a scanner
 * after its `available()` returned true, so this helper never re-probes.
 */
export async function runCliScanner<T>(input: {
  label: string;
  args: string[];
  allowedExitCodes?: number[];
  dockerEntryPoint?: string;
  hostBins: string[];
  image: string;
  options: ScannerRuntimeOptions;
  parse: (text: string) => T[];
  requireOutput?: boolean;
  target: string;
}): Promise<T[]> {
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
    if (input.requireOutput) throw new Error(`${input.label} produced no output`);
    return [];
  }
  return input.parse(text);
}

/** Whether a container image reference is pinned to an immutable `@sha256:` digest. */
export function isDigestPinnedImage(value: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(value);
}

/**
 * Assert a scanner's Docker image is digest-pinned when it would actually run
 * under Docker in production. Lets a plugin enforce — at config-resolution time,
 * i.e. startup — the same supply-chain guard the central env schema used to apply
 * to every `*_IMAGE` key, without the platform knowing the scanner's image.
 */
export function assertDigestPinnedImage(
  image: string,
  envVar: string,
  ctx: ScannerConfigContext,
): void {
  const dockerRuntime = ctx.runtime.cliRuntime === "docker" || ctx.runtime.cliRuntime === "auto";
  if (ctx.isProduction && dockerRuntime && !isDigestPinnedImage(image)) {
    throw new Error(
      `${envVar} must be pinned with @sha256: when the Docker scanner runtime is enabled in production`,
    );
  }
}
