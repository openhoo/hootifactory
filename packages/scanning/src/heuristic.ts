import type { NormalizedFinding, Severity } from "@hootifactory/scan-core";

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
const EICAR_BYTES = new TextEncoder().encode(EICAR);
const EICAR_PREFIX_TABLE = bytePrefixTable(EICAR_BYTES);

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

/** Heuristic malware scan (EICAR signature) over the full artifact bytes. */
export function scanForMalware(bytes: Uint8Array): NormalizedFinding[] {
  if (includesBytes(bytes, EICAR_BYTES, EICAR_PREFIX_TABLE)) {
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

function bytePrefixTable(needle: Uint8Array): Uint16Array {
  const table = new Uint16Array(needle.length);
  let matched = 0;
  for (let i = 1; i < needle.length; i++) {
    while (matched > 0 && needle[i] !== needle[matched]) {
      matched = table[matched - 1] ?? 0;
    }
    if (needle[i] === needle[matched]) matched += 1;
    table[i] = matched;
  }
  return table;
}

function includesBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  prefixTable: Uint16Array,
): boolean {
  if (needle.length === 0) return true;
  let matched = 0;
  for (const byte of haystack) {
    while (matched > 0 && byte !== needle[matched]) {
      matched = prefixTable[matched - 1] ?? 0;
    }
    if (byte === needle[matched]) {
      matched += 1;
      if (matched === needle.length) return true;
    }
  }
  return false;
}
