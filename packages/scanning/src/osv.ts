import type { NormalizedFinding, Severity } from "@hootifactory/scan-core";
import { normalizeSeverity } from "@hootifactory/scan-core";

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
    const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    const severityCache = new Map<string, Severity>();
    async function osvSeverity(id: string): Promise<Severity> {
      const cached = severityCache.get(id);
      if (cached) return cached;
      let severity: Severity = "high";
      const detail = await fetch(`${apiUrl}/v1/vulns/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      }).catch(() => null);
      if (detail?.ok) {
        const vuln = (await detail.json().catch(() => null)) as {
          database_specific?: { severity?: unknown };
          severity?: { score?: unknown }[];
        } | null;
        severity = normalizeSeverity(
          typeof vuln?.database_specific?.severity === "string"
            ? vuln.database_specific.severity
            : undefined,
        );
        for (const item of vuln?.severity ?? []) {
          const parsed = normalizeSeverity(typeof item.score === "string" ? item.score : "");
          if (parsed !== "unknown") severity = parsed;
        }
      }
      severityCache.set(id, severity);
      return severity;
    }
    const out: NormalizedFinding[] = [];
    for (let i = 0; i < (data.results ?? []).length; i++) {
      const result = data.results?.[i];
      const entry = entries[i];
      if (!entry || !result) continue;
      for (const vuln of result.vulns ?? []) {
        out.push({
          type: "vuln",
          vulnId: vuln.id,
          severity: await osvSeverity(vuln.id),
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
