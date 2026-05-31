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

/** Detect which external scanner binaries are installed. */
export function detectScanners(): AvailableScanners {
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
    clamav: has("clamdscan") || has("clamscan"),
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
