import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@hootifactory/config";
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
  runGrypeIfAvailable,
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

  let bytes: Uint8Array | null = null;
  try {
    bytes = await blobStore.getBytes(art.digest);
  } catch {
    // blob may be large/unavailable; skip byte-level scans
  }
  if (bytes) {
    found.push(...scanForMalware(bytes));
    // Run installed external scanners (e.g. Grype) against a scratch copy.
    const scanners = detectScanners();
    if (scanners.grype) {
      let dir: string | null = null;
      try {
        const base = env.SCAN_SCRATCH_DIR.replace(/\/+$/, "");
        await mkdir(base, { recursive: true });
        dir = await mkdtemp(join(base, "scan-"));
        const path = join(dir, art.digest.replace(/[^a-z0-9]/gi, "_"));
        await Bun.write(path, bytes);
        found.push(...(await runGrypeIfAvailable(path)));
      } catch (err) {
        console.error("[scan] external scanner failed", err);
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  if (process.env.SCANNER_OSV === "true") {
    found.push(...(await osvScanDependencies("npm", deps, env.OSV_API_URL)));
  }

  const results = dedupe(found);

  const dedupKey = {
    blobDigest: art.digest,
    scanType: "vuln" as const,
    scanner: "hootifactory-heuristic",
    scannerVersion: "1",
    dbVersion: "builtin",
  };
  // Upsert on the dedup key: identical bytes reuse one scan row, and a retry after
  // a failure flips it back to succeeded. Findings are still attached per-artifact below.
  const [scan] = await db
    .insert(scans)
    .values({
      artifactId: art.id,
      ...dedupKey,
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      sbomNativeJson: { scanners: detectScanners() },
    })
    .onConflictDoUpdate({
      target: [
        scans.blobDigest,
        scans.scanType,
        scans.scanner,
        scans.scannerVersion,
        scans.dbVersion,
      ],
      set: { status: "succeeded", error: null, finishedAt: new Date() },
    })
    .returning({ id: scans.id });

  const scanId = scan?.id;
  if (scanId) {
    // Idempotent: replace this artifact's findings on (re)scan.
    await db.delete(findingsTable).where(eq(findingsTable.artifactId, art.id));
    if (results.length) {
      await db.insert(findingsTable).values(
        results.map((f) => ({
          scanId,
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
  }

  // Policy decision — honor every declared gate, OR-combined.
  let highest: Severity = "unknown";
  let maxCvss = 0;
  for (const f of results) {
    highest = maxSeverity(highest, f.severity);
    if (typeof f.cvssScore === "number") maxCvss = Math.max(maxCvss, f.cvssScore);
  }
  const policy = await loadPolicy(repo.orgId, repo.name);
  const threshold = policy?.blockOnSeverity ?? "low";
  const denyLicenses = policy?.denyLicenses ?? [];
  const severityViolates =
    results.length > 0 && SEVERITY_ORDER[highest] >= SEVERITY_ORDER[threshold];
  // blockOnMalware is a default-ON gate; admins disable it by storing "false".
  const malwareViolates =
    (policy?.blockOnMalware ?? "true") !== "false" && results.some((f) => f.type === "malware");
  const cvssViolates = policy?.maxCvss != null && maxCvss > policy.maxCvss;
  const licenseViolates =
    denyLicenses.length > 0 &&
    results.some((f) => f.type === "license" && !!f.title && denyLicenses.includes(f.title));
  const violates = severityViolates || malwareViolates || cvssViolates || licenseViolates;

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
        reasons: { severityViolates, malwareViolates, cvssViolates, licenseViolates },
      },
    })
    .where(eq(artifacts.id, art.id));
}

/**
 * Record a durable failed-scan row for an artifact when processScan throws, so a
 * scan failure is observable (and recoverable on retry) instead of silently
 * leaving the artifact 'pending'.
 */
export async function recordScanFailure(artifactId: string, err: unknown): Promise<void> {
  const [art] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
  if (!art) return;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  await db
    .insert(scans)
    .values({
      artifactId: art.id,
      blobDigest: art.digest,
      scanType: "vuln",
      scanner: "hootifactory-heuristic",
      scannerVersion: "1",
      dbVersion: "builtin",
      status: "failed",
      error: message,
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        scans.blobDigest,
        scans.scanType,
        scans.scanner,
        scans.scannerVersion,
        scans.dbVersion,
      ],
      set: { status: "failed", error: message, finishedAt: new Date() },
    });
}
