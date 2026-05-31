import {
  and,
  artifacts,
  db,
  eq,
  findings as findingsTable,
  packages,
  packageVersions,
  repositories,
  scanPolicies,
  scans,
} from "@hootifactory/db";
import {
  maxSeverity,
  type NormalizedFinding,
  SEVERITY_ORDER,
  type Severity,
} from "@hootifactory/scan-core";
import {
  detectScanners,
  osvScanDependencies,
  scanDependencies,
  scanForMalware,
} from "@hootifactory/scanning";
import { blobStore } from "@hootifactory/storage";

type PolicyRow = typeof scanPolicies.$inferSelect;

async function loadPolicy(orgId: string, repoName: string): Promise<PolicyRow | null> {
  const rows = await db.select().from(scanPolicies).where(eq(scanPolicies.orgId, orgId));
  let wildcard: PolicyRow | null = null;
  for (const p of rows) {
    if (p.repositoryPattern === repoName) return p;
    if (p.repositoryPattern === "*") wildcard = p;
  }
  return wildcard;
}

function dedupe(items: NormalizedFinding[]): NormalizedFinding[] {
  const seen = new Set<string>();
  const out: NormalizedFinding[] = [];
  for (const f of items) {
    const key = `${f.type}:${f.vulnId ?? f.title ?? ""}:${f.purl ?? f.packageName ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** Run the scan pipeline for one artifact and apply the policy decision. */
export async function processScan(artifactId: string): Promise<void> {
  const [art] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
  if (!art) return;
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, art.repositoryId))
    .limit(1);
  if (!repo) return;

  // Gather dependencies (npm) from the stored version manifest.
  let deps: Record<string, string> = {};
  if (repo.format === "npm" && art.name && art.version) {
    const [pkg] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.repositoryId, repo.id), eq(packages.name, art.name)))
      .limit(1);
    if (pkg) {
      const [pv] = await db
        .select({ metadata: packageVersions.metadata })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, art.version)))
        .limit(1);
      const manifest = (pv?.metadata as { manifest?: Record<string, unknown> })?.manifest as
        | { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        | undefined;
      deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) };
    }
  }

  const found: NormalizedFinding[] = [];
  found.push(...scanDependencies(deps));
  try {
    const bytes = await blobStore.getBytes(art.digest);
    found.push(...scanForMalware(bytes));
  } catch {
    // blob may be large/unavailable; skip malware scan
  }
  if (process.env.SCANNER_OSV === "true") {
    found.push(...(await osvScanDependencies("npm", deps, process.env.OSV_API_URL)));
  }

  const results = dedupe(found);

  const [scan] = await db
    .insert(scans)
    .values({
      artifactId: art.id,
      blobDigest: art.digest,
      scanType: "vuln",
      scanner: "hootifactory-heuristic",
      scannerVersion: "1",
      dbVersion: "builtin",
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      sbomNativeJson: { scanners: detectScanners() },
    })
    .onConflictDoNothing()
    .returning({ id: scans.id });

  if (scan && results.length) {
    await db.insert(findingsTable).values(
      results.map((f) => ({
        scanId: scan.id,
        artifactId: art.id,
        type: f.type,
        vulnId: f.vulnId,
        aliases: f.aliases,
        purl: f.purl,
        packageName: f.packageName,
        packageVersion: f.packageVersion,
        severity: f.severity,
        cvssScore: f.cvssScore,
        fixedVersion: f.fixedVersion,
        title: f.title,
        description: f.description,
        data: f.data ?? null,
      })),
    );
  }

  // Policy decision.
  let highest: Severity = "unknown";
  for (const f of results) highest = maxSeverity(highest, f.severity);
  const policy = await loadPolicy(repo.orgId, repo.name);
  const threshold = policy?.blockOnSeverity ?? "low";
  const violates = results.length > 0 && SEVERITY_ORDER[highest] >= SEVERITY_ORDER[threshold];

  let state: "clean" | "quarantined" | "blocked" = "clean";
  if (violates) state = policy?.mode === "enforce" ? "blocked" : "quarantined";

  await db
    .update(artifacts)
    .set({
      state,
      policyDecision: {
        highest,
        findings: results.length,
        mode: policy?.mode ?? "audit",
        threshold,
      },
    })
    .where(eq(artifacts.id, art.id));
}
