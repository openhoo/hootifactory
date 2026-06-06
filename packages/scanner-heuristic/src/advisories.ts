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
    // No patched release exists: a known-malicious dependency is vulnerable at
    // every version, so leaving `fixedVersion` unset keeps it always-flagged.
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

/**
 * Whether the given `installed` version string is still vulnerable to an
 * advisory fixed in `fixedVersion`. `installed` may be a resolved version or a
 * manifest constraint (e.g. `^1.2.3`, `~1.0.0`); a finding is warranted when it
 * resolves strictly below the fixed version. Fail-safe: when no fixed version is
 * known, or either side cannot be safely interpreted as a concrete dotted
 * release (unparseable, a pre-release, or an upper-bound `<`/`<=` range), the
 * dependency is treated as vulnerable so a patched release is never assumed by
 * mistake.
 */
export function isVersionVulnerable(installed: string, fixedVersion?: string): boolean {
  if (!fixedVersion) return true;
  const cmp = compareReleaseVersions(installed, fixedVersion);
  return cmp === null || cmp < 0;
}

/**
 * Compares two dotted release versions (ecosystem-agnostic, semver-style).
 * Lower-bound range operators are stripped, then the leading numeric release
 * segments are compared field by field. Returns a negative number when `a < b`,
 * zero when equal, a positive number when `a > b`, or `null` when either side
 * has no safely parseable numeric release (see `parseReleaseFields`).
 */
function compareReleaseVersions(a: string, b: string): number | null {
  const left = parseReleaseFields(a);
  const right = parseReleaseFields(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Numeric release fields of a version, or `null` when none can be safely parsed.
 * Fail-safe by design: upper-bound ranges (`<` / `<=`) and pre-release versions
 * cannot be reduced to a single comparable release without risking a false
 * "patched" verdict, so they are rejected (→ vulnerable) rather than guessed.
 */
function parseReleaseFields(version: string): number[] | null {
  const trimmed = version.trim();
  // Upper-bound ranges (`<2.17.0`, `<=2.16.0`) describe versions *below* a bound,
  // not a concrete release; reducing them to the bound would clear the gate.
  if (/^<=?/.test(trimmed)) return null;
  // Drop leading lower-bound range operators / `v` prefix, keeping only the
  // leading dotted numeric release (e.g. `^1.2.3` -> 1.2.3).
  const release = trimmed.replace(/^[\s^~>=v]+/, "");
  const match = release.match(/^\d+(?:\.\d+)*/);
  if (!match) return null;
  // A pre-release / build suffix (e.g. `2.17.0-rc1`) sorts below its stable
  // release, so the stripped numeric core would overstate it; rather than guess,
  // anything trailing the numeric release makes the version unparseable.
  if (match[0].length !== release.length) return null;
  const fields = match[0].split(".").map(Number);
  return fields.every(Number.isFinite) ? fields : null;
}

/** Heuristic dependency scan against the built-in advisory DB. */
export function scanDependenciesAgainstAdvisories(
  deps: Record<string, string> | undefined,
  opts: { purlType?: string } = {},
): NormalizedFinding[] {
  const out: NormalizedFinding[] = [];
  for (const [name, version] of Object.entries(deps ?? {})) {
    const adv = ADVISORIES[name];
    if (adv && isVersionVulnerable(version, adv.fixedVersion)) {
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
