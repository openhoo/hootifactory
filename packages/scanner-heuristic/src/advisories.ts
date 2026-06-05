import type { NormalizedFinding, Severity } from "@hootifactory/scanner";

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

/** Heuristic dependency scan against the built-in advisory DB. */
export function scanDependenciesAgainstAdvisories(
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
