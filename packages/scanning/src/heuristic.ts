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
const EICAR_TAIL_BYTES = Math.max(0, EICAR_BYTES.byteLength - 1);

/** Heuristic dependency scan against the built-in advisory DB. */
export function scanDependencies(
  deps: Record<string, string> | undefined,
  opts: { purlType?: string } = {},
): NormalizedFinding[] {
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
        purl: opts.purlType ? `pkg:${opts.purlType}/${name}@${version}` : undefined,
      });
    }
  }
  return out;
}

function eicarFinding(): NormalizedFinding {
  return {
    type: "malware",
    severity: "critical",
    vulnId: "EICAR-TEST",
    title: "EICAR antivirus test signature detected",
  };
}

export interface MalwareScanner {
  scan: (bytes: Uint8Array) => void;
  findings: () => NormalizedFinding[];
}

export function createMalwareScanner(): MalwareScanner {
  let found = false;
  let tail = new Uint8Array();
  return {
    scan(bytes) {
      if (found || bytes.byteLength === 0) return;
      const searchableBytes =
        tail.byteLength === 0
          ? bytes
          : Buffer.concat([
              Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength),
              Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ]);
      if (Buffer.from(searchableBytes).indexOf(EICAR_BYTES) !== -1) {
        found = true;
        tail = new Uint8Array();
        return;
      }
      tail =
        EICAR_TAIL_BYTES > 0 && searchableBytes.byteLength > 0
          ? searchableBytes.slice(-EICAR_TAIL_BYTES)
          : new Uint8Array();
    },
    findings() {
      return found ? [eicarFinding()] : [];
    },
  };
}

/** Heuristic malware scan (EICAR signature) over the full artifact bytes. */
export function scanForMalware(bytes: Uint8Array): NormalizedFinding[] {
  const scanner = createMalwareScanner();
  scanner.scan(bytes);
  return scanner.findings();
}
