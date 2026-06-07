import { resolve } from "node:path";
import {
  assertDigestPinnedImage,
  type NormalizedFinding,
  runCliScanner,
  type ScannerPlugin,
  scannerCliAvailable,
  stripTrailingSlashes,
  z,
} from "@hootifactory/scanner";

/** Default ClamAV image, digest-pinned. Overridable via the CLAMAV_IMAGE env var. */
const DEFAULT_CLAMAV_IMAGE =
  "clamav/clamav:latest@sha256:d4000290254603e7ee45d4904425c7d98c015af727f402756198fe41a31e7777";

interface ClamavConfig {
  image: string;
  restUrl?: string;
}

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

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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

function isCliWhitespace(code: number): boolean {
  // JS regex \s set, matched explicitly so the parser stays regex-free.
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Extract the signature name from a single `clamscan`/`clamdscan` output line of the
 * form `<path>: <signature> FOUND`. Implemented as a linear, regex-free scan to avoid
 * the polynomial-backtracking ReDoS that an anchored `/:\s*(.+?)\s+FOUND\s*$/` exhibits
 * on adversarial whitespace-heavy lines (CodeQL js/polynomial-redos). Behavior is
 * verified equivalent to that regex, including degenerate all-whitespace segments.
 */
function clamAvSignatureFromLine(line: string): string | undefined {
  // Trailing-whitespace allowance (`\s*$`).
  let end = line.length;
  while (end > 0 && isCliWhitespace(line.charCodeAt(end - 1))) end--;
  const suffix = "FOUND";
  if (end < suffix.length || line.slice(end - suffix.length, end) !== suffix) return undefined;
  const foundStart = end - suffix.length;
  // The `\s+` run immediately before `FOUND` (at least one whitespace char required).
  let wsStart = foundStart;
  while (wsStart > 0 && isCliWhitespace(line.charCodeAt(wsStart - 1))) wsStart--;
  if (wsStart === foundStart) return undefined;
  // Leftmost `:` anchors the match, mirroring `RegExp.exec`.
  const colon = line.indexOf(":");
  if (colon < 0 || colon >= wsStart) return undefined;
  // Skip the leading-whitespace allowance (`\s*`) after the colon.
  let sigStart = colon + 1;
  while (sigStart < wsStart && isCliWhitespace(line.charCodeAt(sigStart))) sigStart++;
  if (sigStart < wsStart) return line.slice(sigStart, wsStart);
  // All-whitespace segment between the colon and the trailing run: the lazy capture
  // takes the second-to-last whitespace char (requires at least two such chars).
  if (foundStart - (colon + 1) >= 2) return line[foundStart - 2];
  return undefined;
}

export function parseClamAvCliFindings(output: string): NormalizedFinding[] {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const name = clamAvSignatureFromLine(line);
    if (name) names.add(name);
  }
  return [...names].map(clamAvFinding);
}

/**
 * ClamAV malware scan. Posts the artifact bytes to a clamav-rest endpoint when
 * `CLAMAV_REST_URL` is configured, otherwise runs the clamscan/clamdscan CLI over
 * the materialized file. The only `content` scanner that consumes the lazy byte
 * source rather than a path.
 */
export const clamavScanner: ScannerPlugin<ClamavConfig> = {
  id: "clamav",
  displayName: "ClamAV",
  scannerVersion: "clamav",
  capabilities: {
    inputKind: "content",
    findingTypes: new Set(["malware"]),
    network: false,
  },
  configFromEnv: (ctx) => {
    const image = ctx.env.CLAMAV_IMAGE ?? DEFAULT_CLAMAV_IMAGE;
    assertDigestPinnedImage(image, "CLAMAV_IMAGE", ctx);
    const restUrl = stripTrailingSlashes(ctx.env.CLAMAV_REST_URL) || undefined;
    return { image, restUrl };
  },
  available: (config, ctx) =>
    Boolean(config.restUrl) || scannerCliAvailable(["clamdscan", "clamscan"], ctx.runtime),
  requiresExternalRuntime: (config) => Boolean(config.restUrl),
  scanContent: async (target, config, ctx) => {
    if (config.restUrl) {
      const res = await fetch(config.restUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        signal: AbortSignal.timeout(ctx.runtime.timeoutMs ?? 120_000),
        body: await target.bytes(),
      });
      if (!res.ok) throw new Error(`clamav REST returned ${res.status}`);
      return parseClamAvRestFindings(await res.json());
    }
    const resolvedTarget = resolve(target.path);
    return runCliScanner({
      label: "clamav",
      args: ["--no-summary", resolvedTarget],
      allowedExitCodes: [0, 1],
      dockerEntryPoint: "clamscan",
      hostBins: ["clamdscan", "clamscan"],
      image: config.image,
      options: ctx.runtime,
      parse: parseClamAvCliFindings,
      target: resolvedTarget,
    });
  },
};
