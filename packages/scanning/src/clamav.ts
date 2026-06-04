import { resolve } from "node:path";
import { z } from "@hootifactory/core";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import {
  type AvailableScanners,
  coerceScannerOptions,
  DEFAULT_SCANNER_IMAGES,
  runScannerAndParse,
  type ScannerRuntimeOptions,
} from "./scanner-runtime";

export type ScannerByteSource = Uint8Array | (() => Promise<Uint8Array>);

const NonEmptyScannerStringSchema = z.string().min(1);
const ClamAvRestSchema = z.looseObject({
  found: z.array(z.unknown()).optional(),
  infected: z.boolean().optional(),
  matches: z.array(z.unknown()).optional(),
  name: z.unknown().optional(),
  signature: z.unknown().optional(),
  signatures: z.array(z.unknown()).optional(),
  virus: z.unknown().optional(),
  viruses: z.array(z.unknown()).optional(),
});
const ClamAvNamedFindingSchema = z.looseObject({
  name: z.unknown().optional(),
  signature: z.unknown().optional(),
  virus: z.unknown().optional(),
});

function clamAvFinding(name: string): NormalizedFinding {
  return {
    type: "malware",
    severity: "critical",
    vulnId: name === "malware" ? "CLAMAV-DETECTED" : `CLAMAV:${name}`,
    title: name === "malware" ? "ClamAV detected malware" : `ClamAV detected ${name}`,
  };
}

export function parseClamAvRestFindings(data: unknown): NormalizedFinding[] {
  const root = ClamAvRestSchema.safeParse(data);
  if (!root.success) return [];
  const body = root.data;
  const names = new Set<string>();
  for (const key of ["matches", "viruses", "signatures", "found"]) {
    const value = body[key as "matches" | "viruses" | "signatures" | "found"] ?? [];
    for (const item of value) {
      if (typeof item === "string" && item) {
        names.add(item);
        continue;
      }
      const record = ClamAvNamedFindingSchema.safeParse(item);
      const name = record.success
        ? (scannerString(record.data.name) ??
          scannerString(record.data.signature) ??
          scannerString(record.data.virus))
        : undefined;
      if (name) names.add(name);
    }
  }
  const signature =
    scannerString(body.signature) ?? scannerString(body.virus) ?? scannerString(body.name);
  if (signature) names.add(signature);
  if (names.size === 0 && body.infected === true) names.add("malware");
  return [...names].map(clamAvFinding);
}

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  bytes: ScannerByteSource | undefined,
  restUrlOrOptions?: string | ScannerRuntimeOptions,
  scanners?: AvailableScanners,
): Promise<NormalizedFinding[]> {
  const options = coerceScannerOptions(restUrlOrOptions, "clamavRestUrl");
  if (options.clamavRestUrl) {
    if (!bytes) throw new Error("clamav REST scanning requires artifact bytes");
    const body = typeof bytes === "function" ? await bytes() : bytes;
    const res = await fetch(options.clamavRestUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      body,
    });
    if (!res.ok) throw new Error(`clamav REST returned ${res.status}`);
    return parseClamAvRestFindings(await res.json());
  }
  const resolvedTarget = resolve(target);
  return runScannerAndParse("clamav", {
    args: ["--no-summary", resolvedTarget],
    allowedExitCodes: [0, 1],
    dockerEntryPoint: "clamscan",
    hostBins: ["clamdscan", "clamscan"],
    image: options.clamavImage ?? DEFAULT_SCANNER_IMAGES.clamav,
    options,
    parse: parseClamAvCliFindings,
    scanners,
    target: resolvedTarget,
  });
}
