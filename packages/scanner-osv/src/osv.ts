import { type NormalizedFinding, normalizeSeverity, type Severity, z } from "@hootifactory/scanner";

const OSV_DETAIL_CONCURRENCY = 8;
const NonEmptyScannerStringSchema = z.string().min(1);
const OsvBatchResponseSchema = z.looseObject({
  results: z.array(z.unknown()).optional(),
});
const OsvResultSchema = z.looseObject({
  vulns: z.array(z.unknown()).optional(),
});
const OsvVulnerabilityRefSchema = z.looseObject({
  id: z.unknown().optional(),
});
const OsvDatabaseSpecificSchema = z.looseObject({
  severity: z.unknown().optional(),
});
const OsvDetailSchema = z.looseObject({
  database_specific: z.unknown().optional(),
  severity: z.array(z.unknown()).optional(),
});
const OsvSeveritySchema = z.looseObject({
  type: z.unknown().optional(),
  score: z.unknown().optional(),
});

function cvssScoreToSeverity(score: number): Severity {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "negligible";
}

function roundUp1(value: number): number {
  return Math.ceil(value * 10) / 10;
}

function parseCvssV3(vector: string): number | undefined {
  const parts = vector.split("/");
  if (parts.length < 2) return undefined;
  if (!parts[0]?.startsWith("CVSS:3")) return undefined;
  const metrics: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const [key, value] = part.split(":");
    if (key && value) metrics[key] = value;
  }

  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.AV ?? ""];
  const ac = { L: 0.77, H: 0.44 }[metrics.AC ?? ""];
  const scope = metrics.S ?? "U";
  const prUnchanged = { N: 0.85, L: 0.62, H: 0.27 }[metrics.PR ?? ""];
  const prChanged = { N: 0.85, L: 0.68, H: 0.5 }[metrics.PR ?? ""];
  const ui = { N: 0.85, R: 0.62 }[metrics.UI ?? ""];
  const c = { H: 0.56, L: 0.22, N: 0 }[metrics.C ?? ""];
  const i = { H: 0.56, L: 0.22, N: 0 }[metrics.I ?? ""];
  const a = { H: 0.56, L: 0.22, N: 0 }[metrics.A ?? ""];

  if (
    av === undefined ||
    ac === undefined ||
    prUnchanged === undefined ||
    prChanged === undefined ||
    ui === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined
  ) {
    return undefined;
  }

  const pr = scope === "C" ? prChanged : prUnchanged;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact =
    scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.max(iss - 0.02, 0) ** 15;
  const exploitability = 8.22 * av * ac * pr * ui;

  if (impact <= 0) return 0;

  const base = scope === "U" ? impact + exploitability : 1.08 * (impact + exploitability);
  return roundUp1(Math.min(base, 10));
}

function parseCvssV2(vector: string): number | undefined {
  const parts = vector.split("/");
  if (parts.length < 2) return undefined;
  if (!parts[0]?.startsWith("CVSS:2")) return undefined;
  const metrics: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const [key, value] = part.split(":");
    if (key && value) metrics[key] = value;
  }

  const av = { L: 0.395, A: 0.646, N: 1.0 }[metrics.AV ?? ""];
  const ac = { H: 0.35, M: 0.61, L: 0.71 }[metrics.AC ?? ""];
  const au = { M: 0.45, S: 0.56, N: 0.704 }[metrics.Au ?? ""];
  const c = { N: 0, P: 0.275, C: 0.66 }[metrics.C ?? ""];
  const i = { N: 0, P: 0.275, C: 0.66 }[metrics.I ?? ""];
  const a = { N: 0, P: 0.275, C: 0.66 }[metrics.A ?? ""];

  if (
    av === undefined ||
    ac === undefined ||
    au === undefined ||
    c === undefined ||
    i === undefined ||
    a === undefined
  ) {
    return undefined;
  }

  const impact = 10.41 * (1 - (1 - c) * (1 - i) * (1 - a));
  const exploitability = 20 * av * ac * au;
  const fImpact = impact === 0 ? 0 : 1.176;
  return roundUp1((0.6 * impact + 0.4 * exploitability - 1.5) * fImpact);
}

function tryParseCvssEntry(entry: {
  type?: unknown;
  score?: unknown;
}): { cvssScore: number; severity: Severity } | undefined {
  const sevType = typeof entry.type === "string" ? entry.type : undefined;
  const sevScore = typeof entry.score === "string" ? entry.score : undefined;
  if (!sevScore) return undefined;

  if (sevType?.startsWith("CVSS")) {
    let numeric: number | undefined;
    if (sevScore.startsWith("CVSS:3")) {
      numeric = parseCvssV3(sevScore);
    } else if (sevScore.startsWith("CVSS:2")) {
      numeric = parseCvssV2(sevScore);
    }
    if (numeric !== undefined) {
      return { cvssScore: numeric, severity: cvssScoreToSeverity(numeric) };
    }
  }

  return undefined;
}

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function stripRange(version: string): string {
  return version.replace(/^[\^~>=<\s]+/, "").trim();
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Result of an OSV dependency lookup. `error` is set when the lookup could not be
 * completed (network/timeout/non-2xx); callers stay fail-open by treating empty
 * `findings` as "no vulns" but should surface `error` so a total OSV outage is not
 * silently indistinguishable from a clean result.
 */
export interface OsvScanResult {
  findings: NormalizedFinding[];
  error?: unknown;
}

/** Optional OSV.dev batch dependency vuln lookup (network). Fail-open: returns an
 * empty `findings` with `error` set when the lookup cannot be completed. */
export async function osvScanDependencies(
  ecosystem: string,
  deps: Record<string, string> | undefined,
  apiUrl = "https://api.osv.dev",
  options: { timeoutMs?: number } = {},
): Promise<OsvScanResult> {
  const entries = Object.entries(deps ?? {});
  if (!entries.length) return { findings: [] };
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
    if (!res.ok) return { findings: [], error: new Error(`OSV querybatch failed: ${res.status}`) };
    const data = OsvBatchResponseSchema.safeParse(await res.json().catch(() => null));
    interface CachedSeverity {
      severity: Severity;
      cvssScore?: number;
    }
    const severityCache = new Map<string, CachedSeverity>();
    async function resolveSeverity(id: string): Promise<CachedSeverity> {
      const cached = severityCache.get(id);
      if (cached) return cached;
      let severity: Severity = "high";
      let cvssScore: number | undefined;
      const detail = await fetch(`${apiUrl}/v1/vulns/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      }).catch(() => null);
      if (detail?.ok) {
        const vuln = OsvDetailSchema.safeParse(await detail.json().catch(() => null));
        const databaseSpecific = OsvDatabaseSpecificSchema.safeParse(
          vuln.success ? vuln.data.database_specific : undefined,
        );
        severity = normalizeSeverity(
          scannerString(databaseSpecific.success ? databaseSpecific.data.severity : undefined),
        );
        const severities = vuln.success ? (vuln.data.severity ?? []) : [];
        for (const item of severities) {
          const parsedSeverity = OsvSeveritySchema.safeParse(item);
          if (!parsedSeverity.success) continue;
          const cvssResult = tryParseCvssEntry(parsedSeverity.data);
          if (cvssResult) {
            severity = cvssResult.severity;
            cvssScore = cvssResult.cvssScore;
          } else {
            const parsed = normalizeSeverity(scannerString(parsedSeverity.data.score));
            if (parsed !== "unknown") severity = parsed;
          }
        }
      }
      const result: CachedSeverity = { severity, cvssScore };
      severityCache.set(id, result);
      return result;
    }
    const out: NormalizedFinding[] = [];
    const results = data.success ? (data.data.results ?? []) : [];
    const vulnIds = new Set<string>();
    for (let i = 0; i < results.length; i++) {
      const result = OsvResultSchema.safeParse(results[i]);
      if (!entries[i] || !result.success) continue;
      const vulns = result.data.vulns ?? [];
      for (const vuln of vulns) {
        const parsedVuln = OsvVulnerabilityRefSchema.safeParse(vuln);
        const id = scannerString(parsedVuln.success ? parsedVuln.data.id : undefined);
        if (id) vulnIds.add(id);
      }
    }
    await mapWithConcurrency([...vulnIds], OSV_DETAIL_CONCURRENCY, async (id) => {
      await resolveSeverity(id);
    });
    for (let i = 0; i < results.length; i++) {
      const result = OsvResultSchema.safeParse(results[i]);
      const entry = entries[i];
      if (!entry || !result.success) continue;
      const vulns = result.data.vulns ?? [];
      for (const vuln of vulns) {
        const parsedVuln = OsvVulnerabilityRefSchema.safeParse(vuln);
        const id = scannerString(parsedVuln.success ? parsedVuln.data.id : undefined);
        if (!id) continue;
        const cached = severityCache.get(id);
        const packageVersion = stripRange(entry[1]);
        out.push({
          type: "vuln",
          vulnId: id,
          severity: cached?.severity ?? "high",
          cvssScore: cached?.cvssScore,
          packageName: entry[0],
          packageVersion,
          purl: `pkg:${ecosystem.toLowerCase()}/${entry[0]}@${packageVersion}`,
        });
      }
    }
    return { findings: out };
  } catch (err) {
    return { findings: [], error: err };
  }
}
