import { dirname, resolve } from "node:path";
import type { NormalizedFinding, Severity } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";

/**
 * Built-in advisory DB powering the offline, deterministic heuristic scanner.
 * Real scanners (Grype/Trivy/OSV) supplement this when available.
 */
export interface Advisory {
  id: string;
  severity: Severity;
  summary: string;
  fixedVersion?: string;
}

export const ADVISORIES: Record<string, Advisory> = {
  "evil-dep": {
    id: "HOOT-2024-0001",
    severity: "critical",
    summary: "Known-malicious dependency",
    fixedVersion: "0.0.0",
  },
  "left-pad-vuln": {
    id: "HOOT-2024-0002",
    severity: "high",
    summary: "Prototype pollution in left-pad-vuln",
    fixedVersion: "1.3.1",
  },
  "log4shell-js": {
    id: "HOOT-2024-0003",
    severity: "critical",
    summary: "Remote code execution via lookup substitution",
    fixedVersion: "2.17.0",
  },
};

// Standard antivirus test signature (ClamAV/heuristic detect it).
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Heuristic dependency scan against the built-in advisory DB. */
export function scanDependencies(deps: Record<string, string> | undefined): NormalizedFinding[] {
  const out: NormalizedFinding[] = [];
  for (const [name, version] of Object.entries(deps ?? {})) {
    const adv = ADVISORIES[name];
    if (adv) {
      out.push({
        type: "vuln",
        vulnId: adv.id,
        severity: adv.severity,
        packageName: name,
        packageVersion: version,
        fixedVersion: adv.fixedVersion,
        title: adv.summary,
        purl: `pkg:npm/${name}@${version}`,
      });
    }
  }
  return out;
}

/** Heuristic malware scan (EICAR signature) over the first chunk of bytes. */
export function scanForMalware(bytes: Uint8Array): NormalizedFinding[] {
  const head = new TextDecoder().decode(bytes.subarray(0, 8192));
  if (head.includes(EICAR)) {
    return [
      {
        type: "malware",
        severity: "critical",
        vulnId: "EICAR-TEST",
        title: "EICAR antivirus test signature detected",
      },
    ];
  }
  return [];
}

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

const DEFAULT_SCANNER_IMAGES = {
  syft: "anchore/syft:latest",
  grype: "anchore/grype:latest",
  trivy: "aquasec/trivy:latest",
  clamav: "clamav/clamav:latest",
} as const;

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

async function runScannerCli(input: {
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

function stripRange(v: string): string {
  return v.replace(/^[\^~>=<\s]+/, "").trim();
}

/** Optional OSV.dev batch dependency vuln lookup (network). Returns [] on failure. */
export async function osvScanDependencies(
  ecosystem: string,
  deps: Record<string, string> | undefined,
  apiUrl = "https://api.osv.dev",
  options: { timeoutMs?: number } = {},
): Promise<NormalizedFinding[]> {
  const entries = Object.entries(deps ?? {});
  if (!entries.length) return [];
  try {
    const res = await fetch(`${apiUrl}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      body: JSON.stringify({
        queries: entries.map(([name, version]) => ({
          package: { ecosystem, name },
          version: stripRange(version),
        })),
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    const severityCache = new Map<string, Severity>();
    async function osvSeverity(id: string): Promise<Severity> {
      const cached = severityCache.get(id);
      if (cached) return cached;
      let severity: Severity = "high";
      const detail = await fetch(`${apiUrl}/v1/vulns/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      }).catch(() => null);
      if (detail?.ok) {
        const vuln = (await detail.json().catch(() => null)) as {
          database_specific?: { severity?: unknown };
          severity?: { score?: unknown }[];
        } | null;
        severity = normalizeSeverity(
          typeof vuln?.database_specific?.severity === "string"
            ? vuln.database_specific.severity
            : undefined,
        );
        for (const item of vuln?.severity ?? []) {
          const parsed = normalizeSeverity(typeof item.score === "string" ? item.score : "");
          if (parsed !== "unknown") severity = parsed;
        }
      }
      severityCache.set(id, severity);
      return severity;
    }
    const out: NormalizedFinding[] = [];
    for (let i = 0; i < (data.results ?? []).length; i++) {
      const r = data.results?.[i];
      const entry = entries[i];
      if (!entry || !r) continue;
      for (const v of r.vulns ?? []) {
        out.push({
          type: "vuln",
          vulnId: v.id,
          severity: await osvSeverity(v.id),
          packageName: entry[0],
          packageVersion: stripRange(entry[1]),
          purl: `pkg:${ecosystem.toLowerCase()}/${entry[0]}@${stripRange(entry[1])}`,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Run Syft (SBOM) + Grype (vuln) over a path, when installed. Returns [] otherwise. */
export async function runGrypeIfAvailable(
  target: string,
  options: ScannerRuntimeOptions = {},
): Promise<NormalizedFinding[]> {
  if (!detectScanners(options).grype) return [];
  const resolvedTarget = resolve(target);
  const text = await runScannerCli({
    args: [resolvedTarget, "-o", "json"],
    hostBins: ["grype"],
    image: options.grypeImage ?? DEFAULT_SCANNER_IMAGES.grype,
    options,
    target: resolvedTarget,
  });
  if (!text) throw new Error("grype produced no output");
  const data = JSON.parse(text) as {
    matches?: {
      vulnerability?: { id?: string; severity?: string; fix?: { versions?: string[] } };
      artifact?: { name?: string; version?: string; purl?: string };
    }[];
  };
  return (data.matches ?? []).map((m) => ({
    type: "vuln" as const,
    vulnId: m.vulnerability?.id,
    severity: normalizeSeverity(m.vulnerability?.severity),
    packageName: m.artifact?.name,
    packageVersion: m.artifact?.version,
    purl: m.artifact?.purl,
    fixedVersion: m.vulnerability?.fix?.versions?.[0],
  }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseTrivyFindings(data: unknown): NormalizedFinding[] {
  const root = asRecord(data);
  const results = Array.isArray(root?.Results) ? root.Results : [];
  const findings: NormalizedFinding[] = [];
  for (const result of results) {
    const row = asRecord(result);
    const vulnerabilities = Array.isArray(row?.Vulnerabilities) ? row.Vulnerabilities : [];
    for (const vulnerability of vulnerabilities) {
      const vuln = asRecord(vulnerability);
      const identifier = asRecord(vuln?.PkgIdentifier);
      findings.push({
        type: "vuln",
        vulnId: asString(vuln?.VulnerabilityID),
        severity: normalizeSeverity(asString(vuln?.Severity)),
        packageName: asString(vuln?.PkgName),
        packageVersion: asString(vuln?.InstalledVersion),
        fixedVersion: asString(vuln?.FixedVersion),
        title: asString(vuln?.Title),
        description: asString(vuln?.Description),
        purl: asString(identifier?.PURL),
      });
    }
  }
  return findings;
}

export function trivyFsArgs(target: string, serverUrl?: string): string[] {
  return [
    "fs",
    "--quiet",
    "--format",
    "json",
    ...(serverUrl ? ["--server", serverUrl] : []),
    target,
  ];
}

export async function runTrivyIfAvailable(
  target: string,
  serverUrlOrOptions?: string | ScannerRuntimeOptions,
): Promise<NormalizedFinding[]> {
  const options =
    typeof serverUrlOrOptions === "string"
      ? { trivyServerUrl: serverUrlOrOptions }
      : (serverUrlOrOptions ?? {});
  if (!detectScanners(options).trivy) return [];
  const resolvedTarget = resolve(target);
  const text = await runScannerCli({
    args: trivyFsArgs(resolvedTarget, options.trivyServerUrl),
    hostBins: ["trivy"],
    image: options.trivyImage ?? DEFAULT_SCANNER_IMAGES.trivy,
    options,
    target: resolvedTarget,
  });
  if (!text) throw new Error("trivy produced no output");
  return parseTrivyFindings(JSON.parse(text));
}

function clamAvFinding(name: string): NormalizedFinding {
  return {
    type: "malware",
    severity: "critical",
    vulnId: name === "malware" ? "CLAMAV-DETECTED" : `CLAMAV:${name}`,
    title: name === "malware" ? "ClamAV detected malware" : `ClamAV detected ${name}`,
  };
}

export function parseClamAvRestFindings(data: unknown): NormalizedFinding[] {
  const root = asRecord(data);
  if (!root) return [];
  const names = new Set<string>();
  for (const key of ["matches", "viruses", "signatures", "found"]) {
    const value = root[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item) {
        names.add(item);
        continue;
      }
      const record = asRecord(item);
      const name = asString(record?.name) ?? asString(record?.signature) ?? asString(record?.virus);
      if (name) names.add(name);
    }
  }
  const signature = asString(root.signature) ?? asString(root.virus) ?? asString(root.name);
  if (signature) names.add(signature);
  if (names.size === 0 && root.infected === true) names.add("malware");
  return [...names].map(clamAvFinding);
}

function parseClamAvCliFindings(output: string): NormalizedFinding[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /:\s*(.+?)\s+FOUND\s*$/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].map(clamAvFinding);
}

export async function runClamAvIfAvailable(
  target: string,
  bytes: Uint8Array,
  restUrlOrOptions?: string | ScannerRuntimeOptions,
): Promise<NormalizedFinding[]> {
  const options =
    typeof restUrlOrOptions === "string"
      ? { clamavRestUrl: restUrlOrOptions }
      : (restUrlOrOptions ?? {});
  if (options.clamavRestUrl) {
    const res = await fetch(options.clamavRestUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      body: bytes,
    });
    if (!res.ok) throw new Error(`clamav REST returned ${res.status}`);
    return parseClamAvRestFindings(await res.json());
  }
  if (!detectScanners(options).clamav) return [];
  const resolvedTarget = resolve(target);
  const stdout = await runScannerCli({
    args: ["--no-summary", resolvedTarget],
    allowedExitCodes: [0, 1],
    dockerEntryPoint: "clamscan",
    hostBins: ["clamdscan", "clamscan"],
    image: options.clamavImage ?? DEFAULT_SCANNER_IMAGES.clamav,
    options,
    target: resolvedTarget,
  });
  if (!stdout) return [];
  return parseClamAvCliFindings(stdout);
}

export async function runExternalScanners(
  target: string,
  bytes: Uint8Array,
  options: ScannerRuntimeOptions = {},
): Promise<NormalizedFinding[]> {
  const scanners = detectScanners(options);
  const findings: NormalizedFinding[] = [];
  if (scanners.grype) findings.push(...(await runGrypeIfAvailable(target, options)));
  if (scanners.trivy) findings.push(...(await runTrivyIfAvailable(target, options)));
  if (scanners.clamav) {
    findings.push(...(await runClamAvIfAvailable(target, bytes, options)));
  }
  return findings;
}
