import { z } from "@hootifactory/core";
import type { NormalizedFinding, Severity } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";

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
  score: z.unknown().optional(),
});

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
    const severityCache = new Map<string, Severity>();
    async function osvSeverity(id: string): Promise<Severity> {
      const cached = severityCache.get(id);
      if (cached) return cached;
      let severity: Severity = "high";
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
          const parsed = normalizeSeverity(
            scannerString(parsedSeverity.success ? parsedSeverity.data.score : undefined),
          );
          if (parsed !== "unknown") severity = parsed;
        }
      }
      severityCache.set(id, severity);
      return severity;
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
      await osvSeverity(id);
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
        const packageVersion = stripRange(entry[1]);
        out.push({
          type: "vuln",
          vulnId: id,
          severity: severityCache.get(id) ?? "high",
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

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
