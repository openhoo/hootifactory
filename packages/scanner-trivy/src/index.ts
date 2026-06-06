import { resolve } from "node:path";
import {
  assertDigestPinnedImage,
  type NormalizedFinding,
  normalizeSeverity,
  runCliScanner,
  type ScannerPlugin,
  safeJsonParse,
  scannerCliAvailable,
  z,
} from "@hootifactory/scanner";

/** Default Trivy image, digest-pinned. Overridable via the TRIVY_IMAGE env var. */
const DEFAULT_TRIVY_IMAGE =
  "aquasec/trivy:latest@sha256:016eae51fdcf989332a5404af7e8f625cd5d95d7c0907a221d080a996f556500";

interface TrivyConfig {
  image: string;
  serverUrl?: string;
}

const NonEmptyScannerStringSchema = z.string().min(1);
const TrivyRootSchema = z.looseObject({
  Results: z.array(z.unknown()).optional(),
});
const TrivyResultSchema = z.looseObject({
  Vulnerabilities: z.array(z.unknown()).optional(),
});
const TrivyVulnerabilitySchema = z.looseObject({
  Description: z.unknown().optional(),
  FixedVersion: z.unknown().optional(),
  InstalledVersion: z.unknown().optional(),
  PkgIdentifier: z.unknown().optional(),
  PkgName: z.unknown().optional(),
  Severity: z.unknown().optional(),
  Title: z.unknown().optional(),
  VulnerabilityID: z.unknown().optional(),
});
const TrivyPackageIdentifierSchema = z.looseObject({
  PURL: z.unknown().optional(),
});

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseTrivyFindings(data: unknown): NormalizedFinding[] {
  const root = TrivyRootSchema.safeParse(data);
  const results = root.success ? (root.data.Results ?? []) : [];
  const findings: NormalizedFinding[] = [];
  for (const result of results) {
    const row = TrivyResultSchema.safeParse(result);
    const vulnerabilities = row.success ? (row.data.Vulnerabilities ?? []) : [];
    for (const vulnerability of vulnerabilities) {
      const vuln = TrivyVulnerabilitySchema.safeParse(vulnerability);
      const identifier = TrivyPackageIdentifierSchema.safeParse(
        vuln.success ? vuln.data.PkgIdentifier : undefined,
      );
      findings.push({
        type: "vuln",
        vulnId: scannerString(vuln.success ? vuln.data.VulnerabilityID : undefined),
        severity: normalizeSeverity(scannerString(vuln.success ? vuln.data.Severity : undefined)),
        packageName: scannerString(vuln.success ? vuln.data.PkgName : undefined),
        packageVersion: scannerString(vuln.success ? vuln.data.InstalledVersion : undefined),
        fixedVersion: scannerString(vuln.success ? vuln.data.FixedVersion : undefined),
        title: scannerString(vuln.success ? vuln.data.Title : undefined),
        description: scannerString(vuln.success ? vuln.data.Description : undefined),
        purl: scannerString(identifier.success ? identifier.data.PURL : undefined),
      });
    }
  }
  return findings;
}

export function trivyFsArgs(target: string, serverUrl?: string): string[] {
  return [
    "fs",
    "--quiet",
    "--format",
    "json",
    ...(serverUrl ? ["--server", serverUrl] : []),
    target,
  ];
}

/** Trivy filesystem (optionally client/server) vulnerability scan over an artifact path. */
export const trivyScanner: ScannerPlugin<TrivyConfig> = {
  id: "trivy",
  displayName: "Trivy",
  scannerVersion: "trivy",
  capabilities: {
    inputKind: "content",
    findingTypes: new Set(["vuln"]),
    network: false,
  },
  configFromEnv: (ctx) => {
    const image = ctx.env.TRIVY_IMAGE ?? DEFAULT_TRIVY_IMAGE;
    assertDigestPinnedImage(image, "TRIVY_IMAGE", ctx);
    const serverUrl = stripTrailingSlashes(ctx.env.TRIVY_SERVER_URL) || undefined;
    return { image, serverUrl };
  },
  available: (_config, ctx) => scannerCliAvailable(["trivy"], ctx.runtime),
  requiresExternalRuntime: (config) => Boolean(config.serverUrl),
  scanContent: (target, config, ctx) => {
    const resolvedTarget = resolve(target.path);
    return runCliScanner({
      label: "trivy",
      args: trivyFsArgs(resolvedTarget, config.serverUrl),
      hostBins: ["trivy"],
      image: config.image,
      options: ctx.runtime,
      parse: (text) => {
        const decoded = safeJsonParse(text);
        if (!decoded.success) throw decoded.error;
        return parseTrivyFindings(decoded.data);
      },
      requireOutput: true,
      target: resolvedTarget,
    });
  },
};

// Trim trailing slashes without a backtracking-prone anchored regex (`/\/+$/`),
// which CodeQL flags as polynomial ReDoS.
function stripTrailingSlashes(value: string | undefined): string | undefined {
  if (!value) return value;
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}
