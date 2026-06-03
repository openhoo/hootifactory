/** Side-effect-free scanning domain types + pure helpers (used by the worker + API). */
import { z } from "zod";

export const JsonRecordSchema = z.record(z.string(), z.unknown());
export type JsonRecord = z.output<typeof JsonRecordSchema>;
export const StringRecordSchema = z.record(z.string(), z.string());
export type StringRecord = z.output<typeof StringRecordSchema>;
const StringValueSchema = z.string();

export function asRecord(value: unknown): JsonRecord | null {
  const parsed = JsonRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function asStringRecord(value: unknown): StringRecord {
  const parsed = JsonRecordSchema.safeParse(value);
  if (!parsed.success) return {};
  const entries = Object.entries(parsed.data).flatMap(([key, item]) => {
    const value = StringValueSchema.safeParse(item);
    return value.success ? ([[key, value.data]] as const) : [];
  });
  return Object.fromEntries(entries);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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

export interface ScanPolicyPattern {
  repositoryPattern: string;
  id?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export function isValidRepositoryPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 256) return false;
  if (pattern.includes("..")) return false;
  if (pattern === "*") return true;
  if (!/[A-Za-z0-9]/.test(pattern)) return false;
  return /^[A-Za-z0-9*][A-Za-z0-9._*-]*$/.test(pattern);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function repositoryPatternMatches(pattern: string, repoName: string): boolean {
  if (!isValidRepositoryPattern(pattern)) return false;
  if (!pattern.includes("*")) return pattern === repoName;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(repoName);
}

function patternSpecificity(pattern: string): {
  exact: number;
  literalChars: number;
  wildcardChars: number;
} {
  const wildcardChars = pattern.length - pattern.replaceAll("*", "").length;
  return {
    exact: wildcardChars === 0 ? 1 : 0,
    literalChars: pattern.length - wildcardChars,
    wildcardChars,
  };
}

function policyTime(policy: ScanPolicyPattern): number {
  const raw = policy.updatedAt ?? policy.createdAt;
  if (!raw) return 0;
  const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function resolveScanPolicy<T extends ScanPolicyPattern>(
  policies: T[],
  repoName: string,
): T | null {
  const matches = policies.filter((policy) =>
    repositoryPatternMatches(policy.repositoryPattern, repoName),
  );
  matches.sort((a, b) => {
    const aSpec = patternSpecificity(a.repositoryPattern);
    const bSpec = patternSpecificity(b.repositoryPattern);
    if (aSpec.exact !== bSpec.exact) return bSpec.exact - aSpec.exact;
    if (aSpec.literalChars !== bSpec.literalChars) {
      return bSpec.literalChars - aSpec.literalChars;
    }
    if (aSpec.wildcardChars !== bSpec.wildcardChars) {
      return aSpec.wildcardChars - bSpec.wildcardChars;
    }
    const timeDelta = policyTime(b) - policyTime(a);
    if (timeDelta !== 0) return timeDelta;
    return String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });
  return matches[0] ?? null;
}
