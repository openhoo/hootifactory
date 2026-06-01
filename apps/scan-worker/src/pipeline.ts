import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@hootifactory/config";
import {
  and,
  artifacts,
  db,
  eq,
  findings as findingsTable,
  ociManifests,
  packages,
  packageVersions,
  repositories,
  scanPolicies,
  scans,
} from "@hootifactory/db";
import {
  maxSeverity,
  type NormalizedFinding,
  resolveScanPolicy,
  SEVERITY_ORDER,
  type Severity,
} from "@hootifactory/scan-core";
import {
  detectScanners,
  osvScanDependencies,
  runExternalScanners,
  scanDependencies,
  scanForMalware,
} from "@hootifactory/scanning";
import { blobStore } from "@hootifactory/storage";
import { ociManifestReferences } from "@hootifactory/types";

type PolicyRow = typeof scanPolicies.$inferSelect;

async function loadPolicy(orgId: string, repoName: string): Promise<PolicyRow | null> {
  const rows = await db.select().from(scanPolicies).where(eq(scanPolicies.orgId, orgId));
  return resolveScanPolicy(rows, repoName);
}

export function dedupeFindings(items: NormalizedFinding[]): NormalizedFinding[] {
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

const OCI_FORMATS = new Set(["docker", "oci", "helm"]);

/** Run the scan pipeline for one artifact and apply the policy decision. */
export async function processScan(artifactId: string): Promise<void> {
  const [art] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
  if (!art) return;
  const artName = art.name;
  const artVersion = art.version;
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, art.repositoryId))
    .limit(1);
  if (!repo) return;
  const repoId = repo.id;
  const repoFormat = repo.format;

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

  let scannedBytePayload = false;
  async function scanStoredBytes(digest: string): Promise<boolean> {
    const stat = await blobStore.stat(digest);
    if (!stat) return false;
    if (stat.size > env.SCAN_MAX_BYTES) {
      throw new Error(
        `blob ${digest} exceeds SCAN_MAX_BYTES (${stat.size} > ${env.SCAN_MAX_BYTES})`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await blobStore.getBytes(digest);
    } catch {
      return false;
    }
    if (bytes.byteLength > env.SCAN_MAX_BYTES) {
      throw new Error(
        `blob ${digest} exceeds SCAN_MAX_BYTES (${bytes.byteLength} > ${env.SCAN_MAX_BYTES})`,
      );
    }
    scannedBytePayload = true;
    found.push(...scanForMalware(bytes));
    const scannerOptions = {
      clamavImage: env.CLAMAV_IMAGE,
      trivyServerUrl: env.TRIVY_SERVER_URL,
      clamavRestUrl: env.CLAMAV_REST_URL,
      cliRuntime: env.SCANNER_CLI_RUNTIME,
      dockerCommand: env.SCANNER_DOCKER_COMMAND,
      grypeImage: env.GRYPE_IMAGE,
      syftImage: env.SYFT_IMAGE,
      trivyImage: env.TRIVY_IMAGE,
    };
    const scanners = detectScanners(scannerOptions);
    if (scanners.grype || scanners.trivy || scanners.clamav) {
      let dir: string | null = null;
      try {
        const base = env.SCAN_SCRATCH_DIR.replace(/\/+$/, "");
        await mkdir(base, { recursive: true });
        dir = await mkdtemp(join(base, "scan-"));
        const path = join(dir, digest.replace(/[^a-z0-9]/gi, "_"));
        await Bun.write(path, bytes);
        found.push(...(await runExternalScanners(path, bytes, scannerOptions)));
      } catch (err) {
        console.error("[scan] external scanner failed", err);
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    return true;
  }

  async function scanOciManifestReferences(
    digest: string,
    seen = new Set<string>(),
  ): Promise<number | null> {
    if (seen.has(digest)) return 0;
    seen.add(digest);
    const [manifest] = await db
      .select({ raw: ociManifests.raw })
      .from(ociManifests)
      .where(and(eq(ociManifests.repositoryId, repoId), eq(ociManifests.digest, digest)))
      .limit(1);
    if (!manifest) return null;
    const refs = ociManifestReferences(manifest.raw);
    let referenceCount = refs.blobs.length + refs.manifests.length;
    for (const blobDigest of refs.blobs) {
      await scanStoredBytes(blobDigest);
    }
    for (const manifestDigest of refs.manifests) {
      referenceCount += (await scanOciManifestReferences(manifestDigest, seen)) ?? 0;
    }
    return referenceCount;
  }

  async function isDeletedPackageVersion(): Promise<boolean> {
    if (!artName || !artVersion) return false;
    const [version] = await db
      .select({ deletedAt: packageVersions.deletedAt })
      .from(packages)
      .innerJoin(packageVersions, eq(packageVersions.packageId, packages.id))
      .where(
        and(
          eq(packages.repositoryId, repoId),
          eq(packages.name, artName),
          eq(packageVersions.version, artVersion),
        ),
      )
      .limit(1);
    return version?.deletedAt != null;
  }

  const scannedDirectBytes = await scanStoredBytes(art.digest);
  let scannedOciManifest = false;
  let ociReferenceCount = 0;
  if (!scannedDirectBytes && OCI_FORMATS.has(repoFormat)) {
    const refs = await scanOciManifestReferences(art.digest);
    scannedOciManifest = refs !== null;
    ociReferenceCount = refs ?? 0;
  }
  if (!scannedBytePayload && Object.keys(deps).length === 0) {
    if (await isDeletedPackageVersion()) {
      await db
        .update(artifacts)
        .set({
          state: "clean",
          policyDecision: { skipped: "package_version_deleted", findings: 0 },
        })
        .where(eq(artifacts.id, art.id));
      return;
    }
    if (scannedOciManifest && ociReferenceCount === 0) {
      await db
        .update(artifacts)
        .set({
          state: "clean",
          policyDecision: { skipped: "oci_manifest_no_scannable_payload", findings: 0 },
        })
        .where(eq(artifacts.id, art.id));
      return;
    }
    throw new Error(`no scannable bytes available for artifact ${art.digest}`);
  }
  if (process.env.SCANNER_OSV === "true") {
    found.push(...(await osvScanDependencies("npm", deps, env.OSV_API_URL)));
  }

  const results = dedupeFindings(found);

  const dedupKey = {
    artifactId: art.id,
    blobDigest: art.digest,
    scanType: "vuln" as const,
    scanner: "hootifactory-heuristic",
    scannerVersion: "1",
    dbVersion: "builtin",
  };
  // Upsert on the per-artifact key so retries replace that artifact's scan
  // result without coupling findings or lifecycle to another artifact that has
  // the same digest.
  const [scan] = await db
    .insert(scans)
    .values({
      ...dedupKey,
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      sbomNativeJson: {
        scanners: detectScanners({
          clamavImage: env.CLAMAV_IMAGE,
          trivyServerUrl: env.TRIVY_SERVER_URL,
          clamavRestUrl: env.CLAMAV_REST_URL,
          cliRuntime: env.SCANNER_CLI_RUNTIME,
          dockerCommand: env.SCANNER_DOCKER_COMMAND,
          grypeImage: env.GRYPE_IMAGE,
          syftImage: env.SYFT_IMAGE,
          trivyImage: env.TRIVY_IMAGE,
        }),
      },
    })
    .onConflictDoUpdate({
      target: [
        scans.artifactId,
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
        scans.artifactId,
        scans.blobDigest,
        scans.scanType,
        scans.scanner,
        scans.scannerVersion,
        scans.dbVersion,
      ],
      set: { status: "failed", error: message, finishedAt: new Date() },
    });
  await db
    .update(artifacts)
    .set({
      policyDecision: {
        scanStatus: "failed",
        error: message,
        failedAt: new Date().toISOString(),
      },
    })
    .where(eq(artifacts.id, art.id));
}
