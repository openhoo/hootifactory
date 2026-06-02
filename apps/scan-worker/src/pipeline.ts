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
  scans,
} from "@hootifactory/db";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withLogAttributes,
  withSpan,
} from "@hootifactory/observability";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import {
  detectScanners,
  osvScanDependencies,
  runExternalScanners,
  scanDependencies,
  scanForMalware,
  scannerOptionsFromEnv,
} from "@hootifactory/scanning";
import { blobStore } from "@hootifactory/storage";
import { ociManifestReferences } from "@hootifactory/types";
import { collectPackageDependencies } from "./scan-dependencies";
import { dedupeFindings, evaluateScanPolicy, loadPolicy } from "./scan-policy";

export { dedupeFindings } from "./scan-policy";

const OCI_FORMATS = new Set(["docker", "oci", "helm"]);

// Shared pg unique-key for the scans table so the success upsert and the
// failure upsert stay byte-for-byte aligned (drift would break idempotency).
const SCAN_CONFLICT_TARGET = [
  scans.artifactId,
  scans.blobDigest,
  scans.scanType,
  scans.scanner,
  scans.scannerVersion,
  scans.dbVersion,
];
const SCAN_DEDUP_FIELDS = {
  scanType: "vuln" as const,
  scanner: "hootifactory-heuristic",
  scannerVersion: "1",
  dbVersion: "builtin",
} as const;

/** Run the scan pipeline for one artifact and apply the policy decision. */
export async function processScan(artifactId: string): Promise<void> {
  await withLogAttributes({ "artifact.id": artifactId }, async () => {
    await withSpan("scan.process_artifact", { "artifact.id": artifactId }, async () => {
      await processScanInner(artifactId);
    });
  });
}

interface ScanContext {
  art: typeof artifacts.$inferSelect;
  repo: typeof repositories.$inferSelect;
}

/** Load and validate the artifact + repository, recording span/log state. */
async function loadScanContext(artifactId: string): Promise<ScanContext | null> {
  const [art] = await withSpan("scan.load_artifact", { "artifact.id": artifactId }, () =>
    db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1),
  );
  if (!art) {
    addSpanEvent("scan.artifact_missing", { "artifact.id": artifactId });
    logger.warn("scan artifact missing", { artifactId });
    return null;
  }
  setActiveSpanAttributes({
    "artifact.digest": art.digest,
    "artifact.name": art.name ?? "",
    "artifact.version": art.version ?? "",
  });
  const [repo] = await withSpan(
    "scan.load_repository",
    { "registry.repository.id": art.repositoryId },
    () => db.select().from(repositories).where(eq(repositories.id, art.repositoryId)).limit(1),
  );
  if (!repo) {
    addSpanEvent("scan.repository_missing", { "registry.repository.id": art.repositoryId });
    logger.warn("scan repository missing", { artifactId, repositoryId: art.repositoryId });
    return null;
  }
  setActiveSpanAttributes({
    "registry.format": repo.format,
    "registry.repository.id": repo.id,
    "registry.repository.name": repo.name,
  });
  logger.info("scan artifact started", {
    artifactId: art.id,
    digest: art.digest,
    repo: repo.name,
    format: repo.format,
  });
  return { art, repo };
}

async function processScanInner(artifactId: string): Promise<void> {
  const context = await loadScanContext(artifactId);
  if (!context) return;
  const { art, repo } = context;
  const artName = art.name;
  const artVersion = art.version;
  const repoId = repo.id;
  const repoFormat = repo.format;

  const { deps, osvEcosystem } = await collectPackageDependencies({
    repositoryId: repo.id,
    repositoryFormat: repo.format,
    artifactName: art.name,
    artifactVersion: art.version,
  });

  const found: NormalizedFinding[] = [];
  await withSpan("scan.heuristic_dependencies", {}, async (span) => {
    const dependencyFindings = scanDependencies(deps);
    found.push(...dependencyFindings);
    span.setAttribute("scan.findings.count", dependencyFindings.length);
  });

  let scannedBytePayload = false;
  async function scanStoredBytes(digest: string): Promise<boolean> {
    return withSpan("scan.bytes", { "artifact.digest": digest }, async (span) => {
      const stat = await blobStore.stat(digest);
      if (!stat) {
        span.setAttribute("scan.bytes.available", false);
        addSpanEvent("scan.bytes_missing", { "artifact.digest": digest });
        return false;
      }
      span.setAttributes({
        "scan.bytes.available": true,
        "artifact.size": stat.size,
        "scan.max_bytes": env.SCAN_MAX_BYTES,
      });
      if (stat.size > env.SCAN_MAX_BYTES) {
        addSpanEvent("scan.bytes_too_large", { "artifact.size": stat.size });
        throw new Error(
          `blob ${digest} exceeds SCAN_MAX_BYTES (${stat.size} > ${env.SCAN_MAX_BYTES})`,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await blobStore.getBytes(digest);
      } catch {
        addSpanEvent("scan.bytes_read_failed", { "artifact.digest": digest });
        return false;
      }
      if (bytes.byteLength > env.SCAN_MAX_BYTES) {
        addSpanEvent("scan.bytes_too_large", { "artifact.size": bytes.byteLength });
        throw new Error(
          `blob ${digest} exceeds SCAN_MAX_BYTES (${bytes.byteLength} > ${env.SCAN_MAX_BYTES})`,
        );
      }
      scannedBytePayload = true;
      const malwareFindings = scanForMalware(bytes);
      found.push(...malwareFindings);
      span.setAttribute("scan.malware.findings", malwareFindings.length);
      const scannerOptions = scannerOptionsFromEnv();
      const scanners = detectScanners(scannerOptions);
      span.setAttributes({
        "scan.external.grype": Boolean(scanners.grype),
        "scan.external.trivy": Boolean(scanners.trivy),
        "scan.external.clamav": Boolean(scanners.clamav),
      });
      if (scanners.grype || scanners.trivy || scanners.clamav) {
        let dir: string | null = null;
        try {
          const base = env.SCAN_SCRATCH_DIR.replace(/\/+$/, "");
          await mkdir(base, { recursive: true });
          dir = await mkdtemp(join(base, "scan-"));
          const path = join(dir, digest.replace(/[^a-z0-9]/gi, "_"));
          await Bun.write(path, bytes);
          const externalFindings = await runExternalScanners(path, bytes, scannerOptions);
          found.push(...externalFindings);
          span.setAttribute("scan.external.findings", externalFindings.length);
        } catch (err) {
          addSpanEvent("scan.external_failed", { "error.message": String(err) });
          logger.error("external scanner failed", { error: err });
          throw err;
        } finally {
          if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
      return true;
    });
  }

  async function scanOciManifestReferences(
    digest: string,
    seen = new Set<string>(),
  ): Promise<number | null> {
    return withSpan("scan.oci_manifest", { "artifact.digest": digest }, async (span) => {
      if (seen.has(digest)) {
        span.setAttribute("scan.oci_manifest.seen", true);
        return 0;
      }
      seen.add(digest);
      const [manifest] = await db
        .select({ raw: ociManifests.raw })
        .from(ociManifests)
        .where(and(eq(ociManifests.repositoryId, repoId), eq(ociManifests.digest, digest)))
        .limit(1);
      if (!manifest) {
        span.setAttribute("scan.oci_manifest.found", false);
        return null;
      }
      span.setAttribute("scan.oci_manifest.found", true);
      const refs = ociManifestReferences(manifest.raw);
      span.setAttributes({
        "scan.oci_manifest.blob_refs": refs.blobs.length,
        "scan.oci_manifest.manifest_refs": refs.manifests.length,
      });
      let referenceCount = refs.blobs.length + refs.manifests.length;
      for (const blobDigest of refs.blobs) {
        await scanStoredBytes(blobDigest);
      }
      for (const manifestDigest of refs.manifests) {
        referenceCount += (await scanOciManifestReferences(manifestDigest, seen)) ?? 0;
      }
      span.setAttribute("scan.oci_manifest.reference_count", referenceCount);
      return referenceCount;
    });
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
      await markSkippedClean(art, "package_version_deleted");
      return;
    }
    if (scannedOciManifest && ociReferenceCount === 0) {
      await markSkippedClean(art, "oci_manifest_no_scannable_payload");
      return;
    }
    throw new Error(`no scannable bytes available for artifact ${art.digest}`);
  }
  if (env.SCANNER_OSV) {
    await withSpan(
      "scan.osv_dependencies",
      { "scan.osv.api_url": env.OSV_API_URL },
      async (span) => {
        const osvFindings = await osvScanDependencies(osvEcosystem, deps, env.OSV_API_URL, {
          timeoutMs: env.SCANNER_TIMEOUT_MS,
        });
        found.push(...osvFindings);
        span.setAttribute("scan.findings.count", osvFindings.length);
      },
    );
  }

  const results = dedupeFindings(found);
  setActiveSpanAttributes({ "scan.findings.count": results.length });

  await persistScanResult(art, results);
  await applyPolicyDecision(art, repo, results);
}

/** Upsert the per-artifact scan row and replace its findings with `results`. */
async function persistScanResult(
  art: typeof artifacts.$inferSelect,
  results: NormalizedFinding[],
): Promise<void> {
  const dedupKey = {
    artifactId: art.id,
    blobDigest: art.digest,
    ...SCAN_DEDUP_FIELDS,
  };
  // Upsert on the per-artifact key so retries replace that artifact's scan
  // result without coupling findings or lifecycle to another artifact that has
  // the same digest.
  const [scan] = await withSpan(
    "scan.persist_result",
    {
      "artifact.id": art.id,
      "artifact.digest": art.digest,
      "scan.findings.count": results.length,
    },
    () =>
      db
        .insert(scans)
        .values({
          ...dedupKey,
          status: "succeeded",
          startedAt: new Date(),
          finishedAt: new Date(),
          sbomNativeJson: {
            scanners: detectScanners(scannerOptionsFromEnv()),
          },
        })
        .onConflictDoUpdate({
          target: SCAN_CONFLICT_TARGET,
          set: { status: "succeeded", error: null, finishedAt: new Date() },
        })
        .returning({ id: scans.id }),
  );

  const scanId = scan?.id;
  if (scanId) {
    // Idempotent: replace this artifact's findings on (re)scan.
    await withSpan(
      "scan.persist_findings",
      { "scan.id": scanId, "scan.findings.count": results.length },
      async () => {
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
      },
    );
  }
}

/** Load the repository policy, evaluate it against `results`, and persist the decision. */
async function applyPolicyDecision(
  art: typeof artifacts.$inferSelect,
  repo: typeof repositories.$inferSelect,
  results: NormalizedFinding[],
): Promise<void> {
  const policy = await withSpan("scan.load_policy", { "registry.repository.name": repo.name }, () =>
    loadPolicy(repo.orgId, repo.name),
  );
  const policyEvaluation = evaluateScanPolicy(results, policy);

  await db
    .update(artifacts)
    .set({
      state: policyEvaluation.state,
      policyDecision: {
        highest: policyEvaluation.highest,
        findings: results.length,
        mode: policyEvaluation.mode,
        threshold: policyEvaluation.threshold,
        reasons: policyEvaluation.reasons,
      },
    })
    .where(eq(artifacts.id, art.id));
  setActiveSpanAttributes({
    "scan.policy.mode": policyEvaluation.mode,
    "scan.policy.result": policyEvaluation.state,
    "scan.findings.highest_severity": policyEvaluation.highest,
  });
  logger.info("scan artifact completed", {
    artifactId: art.id,
    digest: art.digest,
    repo: repo.name,
    state: policyEvaluation.state,
    findings: results.length,
    highest: policyEvaluation.highest,
  });
}

/** Mark an artifact clean and skipped (no scannable payload) with the given reason. */
async function markSkippedClean(art: typeof artifacts.$inferSelect, reason: string): Promise<void> {
  addSpanEvent("scan.skipped", { "scan.skip_reason": reason });
  await db
    .update(artifacts)
    .set({
      state: "clean",
      policyDecision: { skipped: reason, findings: 0 },
    })
    .where(eq(artifacts.id, art.id));
  logger.info("scan artifact skipped", {
    artifactId: art.id,
    digest: art.digest,
    reason,
  });
}

/**
 * Record a durable failed-scan row for an artifact when processScan throws, so a
 * scan failure is observable (and recoverable on retry) instead of silently
 * leaving the artifact 'pending'.
 */
export async function recordScanFailure(artifactId: string, err: unknown): Promise<void> {
  const [art] = await withSpan("scan.record_failure", { "artifact.id": artifactId }, () =>
    db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1),
  );
  if (!art) return;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  await db
    .insert(scans)
    .values({
      artifactId: art.id,
      blobDigest: art.digest,
      ...SCAN_DEDUP_FIELDS,
      status: "failed",
      error: message,
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: SCAN_CONFLICT_TARGET,
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
  logger.warn("scan failure recorded", { artifactId, digest: art.digest, error: message });
}
