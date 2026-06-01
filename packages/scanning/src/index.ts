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

export interface ScannerRuntimeOptions {
  trivyServerUrl?: string;
  clamavRestUrl?: string;
}

/** Detect which external scanner binaries are installed. */
export function detectScanners(options: ScannerRuntimeOptions = {}): AvailableScanners {
  const has = (bin: string) => {
    try {
      return Boolean(Bun.which(bin));
    } catch {
      return false;
    }
  };
  return {
    syft: has("syft"),
    grype: has("grype"),
    trivy: has("trivy"),
    clamav: Boolean(options.clamavRestUrl) || has("clamdscan") || has("clamscan"),
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
): Promise<NormalizedFinding[]> {
  const entries = Object.entries(deps ?? {});
  if (!entries.length) return [];
  try {
    const res = await fetch(`${apiUrl}/v1/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: entries.map(([name, version]) => ({
          package: { ecosystem, name },
          version: stripRange(version),
        })),
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    const out: NormalizedFinding[] = [];
    (data.results ?? []).forEach((r, i) => {
      const entry = entries[i];
      if (!entry) return;
      for (const v of r.vulns ?? []) {
        out.push({
          type: "vuln",
          vulnId: v.id,
          // OSV's querybatch returns only ids (no severity). Default a confirmed
          // match to a conservative "high" so it is not silently non-blocking;
          // a richer per-id severity lookup is a follow-up.
          severity: "high",
          packageName: entry[0],
          packageVersion: stripRange(entry[1]),
          purl: `pkg:${ecosystem.toLowerCase()}/${entry[0]}@${stripRange(entry[1])}`,
        });
      }
    });
    return out;
  } catch {
    return [];
  }
}

/** Run Syft (SBOM) + Grype (vuln) over a path, when installed. Returns [] otherwise. */
export async function runGrypeIfAvailable(target: string): Promise<NormalizedFinding[]> {
  if (!detectScanners().grype) return [];
  try {
    const proc = Bun.spawn(["grype", target, "-o", "json"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
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
  } catch {
    return [];
  }
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
  serverUrl?: string,
): Promise<NormalizedFinding[]> {
  if (!detectScanners().trivy) return [];
  try {
    const proc = Bun.spawn(["trivy", ...trivyFsArgs(target, serverUrl)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return parseTrivyFindings(JSON.parse(text));
  } catch {
    return [];
  }
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
  restUrl?: string,
): Promise<NormalizedFinding[]> {
  if (restUrl) {
    try {
      const res = await fetch(restUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      });
      if (!res.ok) return [];
      return parseClamAvRestFindings(await res.json());
    } catch {
      return [];
    }
  }
  const bin = Bun.which("clamdscan") ? "clamdscan" : Bun.which("clamscan") ? "clamscan" : null;
  if (!bin) return [];
  try {
    const proc = Bun.spawn([bin, "--no-summary", target], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return parseClamAvCliFindings(`${stdout}\n${stderr}`);
  } catch {
    return [];
  }
}

export async function runExternalScanners(
  target: string,
  bytes: Uint8Array,
  options: ScannerRuntimeOptions = {},
): Promise<NormalizedFinding[]> {
  const scanners = detectScanners(options);
  const findings: NormalizedFinding[] = [];
  if (scanners.grype) findings.push(...(await runGrypeIfAvailable(target)));
  if (scanners.trivy) findings.push(...(await runTrivyIfAvailable(target, options.trivyServerUrl)));
  if (scanners.clamav) {
    findings.push(...(await runClamAvIfAvailable(target, bytes, options.clamavRestUrl)));
  }
  return findings;
}
