import type { NormalizedFinding, Severity } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";
import { asRecord, asString } from "./scanner-json";

function stripRange(version: string): string {
  return version.replace(/^[\^~>=<\s]+/, "").trim();
}

/** Optional OSV.dev batch dependency vuln lookup (network). Returns [] on failure. */
export async function osvScanDependencies(
  ecosystem: string,
  deps: Record<string, string> | undefined,
  apiUrl = "https://api.osv.dev",
  options: { timeoutMs?: number } = {},
): Promise<NormalizedFinding[]> {
  const entries = Object.entries(deps ?? {});
  if (!entries.length) return [];
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
    if (!res.ok) return [];
    const data = asRecord(await res.json().catch(() => null));
    const severityCache = new Map<string, Severity>();
    async function osvSeverity(id: string): Promise<Severity> {
      const cached = severityCache.get(id);
      if (cached) return cached;
      let severity: Severity = "high";
      const detail = await fetch(`${apiUrl}/v1/vulns/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      }).catch(() => null);
      if (detail?.ok) {
        const vuln = asRecord(await detail.json().catch(() => null));
        const databaseSpecific = asRecord(vuln?.database_specific);
        severity = normalizeSeverity(asString(databaseSpecific?.severity));
        const severities = Array.isArray(vuln?.severity) ? vuln.severity : [];
        for (const item of severities) {
          const parsed = normalizeSeverity(asString(asRecord(item)?.score));
          if (parsed !== "unknown") severity = parsed;
        }
      }
      severityCache.set(id, severity);
      return severity;
    }
    const out: NormalizedFinding[] = [];
    const results = Array.isArray(data?.results) ? data.results : [];
    for (let i = 0; i < results.length; i++) {
      const result = asRecord(results[i]);
      const entry = entries[i];
      if (!entry || !result) continue;
      const vulns = Array.isArray(result.vulns) ? result.vulns : [];
      for (const vuln of vulns) {
        const id = asString(asRecord(vuln)?.id);
        if (!id) continue;
        out.push({
          type: "vuln",
          vulnId: id,
          severity: await osvSeverity(id),
          packageName: entry[0],
          packageVersion: stripRange(entry[1]),
          purl: `pkg:${ecosystem.toLowerCase()}/${entry[0]}@${stripRange(entry[1])}`,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
