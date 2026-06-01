import { db, eq, scanPolicies } from "@hootifactory/db";
import {
  maxSeverity,
  type NormalizedFinding,
  resolveScanPolicy,
  SEVERITY_ORDER,
  type Severity,
} from "@hootifactory/scan-core";

type PolicyRow = typeof scanPolicies.$inferSelect;
type ArtifactState = "clean" | "quarantined" | "blocked";
type PolicyMode = "audit" | "enforce";

export interface ScanPolicyRules {
  mode?: PolicyMode | null;
  blockOnSeverity?: Severity | null;
  blockOnMalware?: string | null;
  denyLicenses?: string[] | null;
  maxCvss?: number | null;
}

export interface ScanPolicyEvaluation {
  highest: Severity;
  maxCvss: number;
  mode: PolicyMode;
  threshold: Severity;
  reasons: {
    severityViolates: boolean;
    malwareViolates: boolean;
    cvssViolates: boolean;
    licenseViolates: boolean;
  };
  state: ArtifactState;
}

export async function loadPolicy(orgId: string, repoName: string): Promise<PolicyRow | null> {
  const rows = await db.select().from(scanPolicies).where(eq(scanPolicies.orgId, orgId));
  return resolveScanPolicy(rows, repoName);
}

export function dedupeFindings(items: NormalizedFinding[]): NormalizedFinding[] {
  const seen = new Set<string>();
  const out: NormalizedFinding[] = [];
  for (const finding of items) {
    const key = `${finding.type}:${finding.vulnId ?? finding.title ?? ""}:${
      finding.purl ?? finding.packageName ?? ""
    }`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(finding);
    }
  }
  return out;
}

export function evaluateScanPolicy(
  findings: readonly NormalizedFinding[],
  policy: ScanPolicyRules | null | undefined,
): ScanPolicyEvaluation {
  const { highest, maxCvss } = summarizeFindings(findings);
  const threshold = policy?.blockOnSeverity ?? "low";
  const denyLicenses = policy?.denyLicenses ?? [];
  const reasons = {
    severityViolates: findings.length > 0 && SEVERITY_ORDER[highest] >= SEVERITY_ORDER[threshold],
    malwareViolates:
      (policy?.blockOnMalware ?? "true") !== "false" &&
      findings.some((finding) => finding.type === "malware"),
    cvssViolates: policy?.maxCvss != null && maxCvss > policy.maxCvss,
    licenseViolates:
      denyLicenses.length > 0 &&
      findings.some(
        (finding) =>
          finding.type === "license" && !!finding.title && denyLicenses.includes(finding.title),
      ),
  };
  const violates =
    reasons.severityViolates ||
    reasons.malwareViolates ||
    reasons.cvssViolates ||
    reasons.licenseViolates;
  const mode = policy?.mode ?? "audit";

  return {
    highest,
    maxCvss,
    mode,
    threshold,
    reasons,
    state: violates ? (mode === "enforce" ? "blocked" : "quarantined") : "clean",
  };
}

function summarizeFindings(findings: readonly NormalizedFinding[]): {
  highest: Severity;
  maxCvss: number;
} {
  let highest: Severity = "unknown";
  let maxCvss = 0;
  for (const finding of findings) {
    highest = maxSeverity(highest, finding.severity);
    if (typeof finding.cvssScore === "number") {
      maxCvss = Math.max(maxCvss, finding.cvssScore);
    }
  }
  return { highest, maxCvss };
}
