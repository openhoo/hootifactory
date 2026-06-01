import { resolve } from "node:path";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { asRecord, asString } from "./scanner-json";
import {
  DEFAULT_SCANNER_IMAGES,
  detectScanners,
  runScannerCli,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

function clamAvFinding(name: string): NormalizedFinding {
  return {
    type: "malware",
    severity: "critical",
    vulnId: name === "malware" ? "CLAMAV-DETECTED" : `CLAMAV:${name}`,
    title: name === "malware" ? "ClamAV detected malware" : `ClamAV detected ${name}`,
  };
}

export function parseClamAvRestFindings(data: unknown): NormalizedFinding[] {
  const root = asRecord(data);
  if (!root) return [];
  const names = new Set<string>();
  for (const key of ["matches", "viruses", "signatures", "found"]) {
    const value = root[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item) {
        names.add(item);
        continue;
      }
      const record = asRecord(item);
      const name = asString(record?.name) ?? asString(record?.signature) ?? asString(record?.virus);
      if (name) names.add(name);
    }
  }
  const signature = asString(root.signature) ?? asString(root.virus) ?? asString(root.name);
  if (signature) names.add(signature);
  if (names.size === 0 && root.infected === true) names.add("malware");
  return [...names].map(clamAvFinding);
}

function parseClamAvCliFindings(output: string): NormalizedFinding[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /:\s*(.+?)\s+FOUND\s*$/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].map(clamAvFinding);
}

export async function runClamAvIfAvailable(
  target: string,
  bytes: Uint8Array,
  restUrlOrOptions?: string | ScannerRuntimeOptions,
): Promise<NormalizedFinding[]> {
  const options =
    typeof restUrlOrOptions === "string"
      ? { clamavRestUrl: restUrlOrOptions }
      : (restUrlOrOptions ?? {});
  if (options.clamavRestUrl) {
    const res = await fetch(options.clamavRestUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      body: bytes,
    });
    if (!res.ok) throw new Error(`clamav REST returned ${res.status}`);
    return parseClamAvRestFindings(await res.json());
  }
  if (!detectScanners(options).clamav) return [];
  const resolvedTarget = resolve(target);
  const stdout = await runScannerCli({
    args: ["--no-summary", resolvedTarget],
    allowedExitCodes: [0, 1],
    dockerEntryPoint: "clamscan",
    hostBins: ["clamdscan", "clamscan"],
    image: options.clamavImage ?? DEFAULT_SCANNER_IMAGES.clamav,
    options,
    target: resolvedTarget,
  });
  if (!stdout) return [];
  return parseClamAvCliFindings(stdout);
}
