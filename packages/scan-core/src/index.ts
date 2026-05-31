/** Side-effect-free scanning domain types + pure helpers (used by the worker + API). */

export type Severity = "critical" | "high" | "medium" | "low" | "negligible" | "unknown";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  negligible: 1,
  unknown: 0,
};

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/** Map a scanner's severity label to our canonical scale. */
export function normalizeSeverity(raw: string | null | undefined): Severity {
  switch ((raw ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    case "low":
      return "low";
    case "negligible":
    case "info":
    case "informational":
      return "negligible";
    default:
      return "unknown";
  }
}

export type FindingType = "vuln" | "license" | "secret" | "malware";

export interface NormalizedFinding {
  type: FindingType;
  vulnId?: string;
  aliases?: string[];
  purl?: string;
  packageName?: string;
  packageVersion?: string;
  severity: Severity;
  cvssScore?: number;
  fixedVersion?: string;
  title?: string;
  description?: string;
  data?: Record<string, unknown>;
}

export interface SbomComponent {
  purl?: string;
  name: string;
  version?: string;
  type?: string;
  licenses: string[];
}

/** Dedupe key for a finding across scanners. */
export function findingKey(f: NormalizedFinding): string {
  return `${f.type}:${f.vulnId ?? f.title ?? ""}:${f.purl ?? f.packageName ?? ""}`;
}
