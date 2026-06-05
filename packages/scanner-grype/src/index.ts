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

/** Default Grype image, digest-pinned. Overridable via the GRYPE_IMAGE env var. */
const DEFAULT_GRYPE_IMAGE =
  "anchore/grype:latest@sha256:e5b03c0ec0bc20a9eaaf84c2dcc97d9890f4dfb4381fce26bffc7dd8527c3d9d";

interface GrypeConfig {
  image: string;
}

const NonEmptyScannerStringSchema = z.string().min(1);
const GrypeOutputSchema = z.looseObject({
  matches: z.array(z.unknown()).optional(),
});
const GrypeMatchSchema = z.looseObject({
  artifact: z.unknown().optional(),
  vulnerability: z.unknown().optional(),
});
const GrypeVulnerabilitySchema = z.looseObject({
  fix: z.unknown().optional(),
  id: z.unknown().optional(),
  severity: z.unknown().optional(),
});
const GrypeFixSchema = z.looseObject({
  versions: z.array(z.unknown()).optional(),
});
const GrypeArtifactSchema = z.looseObject({
  name: z.unknown().optional(),
  purl: z.unknown().optional(),
  version: z.unknown().optional(),
});

function scannerString(value: unknown): string | undefined {
  const parsed = NonEmptyScannerStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseGrypeMatches(text: string): NormalizedFinding[] {
  const decoded = safeJsonParse(text);
  if (!decoded.success) throw decoded.error;
  const data = GrypeOutputSchema.safeParse(decoded.data);
  const matches = data.success ? (data.data.matches ?? []) : [];
  const findings: NormalizedFinding[] = [];
  for (const match of matches) {
    const row = GrypeMatchSchema.safeParse(match);
    const vulnerability = GrypeVulnerabilitySchema.safeParse(
      row.success ? row.data.vulnerability : undefined,
    );
    const artifact = GrypeArtifactSchema.safeParse(row.success ? row.data.artifact : undefined);
    const fix = GrypeFixSchema.safeParse(
      vulnerability.success ? vulnerability.data.fix : undefined,
    );
    const versions = fix.success ? (fix.data.versions ?? []) : [];
    findings.push({
      type: "vuln",
      vulnId: scannerString(vulnerability.success ? vulnerability.data.id : undefined),
      severity: normalizeSeverity(
        scannerString(vulnerability.success ? vulnerability.data.severity : undefined),
      ),
      packageName: scannerString(artifact.success ? artifact.data.name : undefined),
      packageVersion: scannerString(artifact.success ? artifact.data.version : undefined),
      purl: scannerString(artifact.success ? artifact.data.purl : undefined),
      fixedVersion: scannerString(versions[0]),
    });
  }
  return findings;
}

/** Grype (Syft SBOM + vulnerability) scan over a materialized artifact path. */
export const grypeScanner: ScannerPlugin<GrypeConfig> = {
  id: "grype",
  displayName: "Grype",
  scannerVersion: "grype",
  capabilities: {
    inputKind: "content",
    findingTypes: new Set(["vuln"]),
    network: false,
  },
  configFromEnv: (ctx) => {
    const image = ctx.env.GRYPE_IMAGE ?? DEFAULT_GRYPE_IMAGE;
    assertDigestPinnedImage(image, "GRYPE_IMAGE", ctx);
    return { image };
  },
  available: (_config, ctx) => scannerCliAvailable(["grype"], ctx.runtime),
  scanContent: (target, config, ctx) => {
    const resolvedTarget = resolve(target.path);
    return runCliScanner({
      label: "grype",
      args: [resolvedTarget, "-o", "json"],
      hostBins: ["grype"],
      image: config.image,
      options: ctx.runtime,
      parse: parseGrypeMatches,
      requireOutput: true,
      target: resolvedTarget,
    });
  },
};
