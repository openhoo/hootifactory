import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@hootifactory/config";
import {
  and,
  artifacts,
  db,
  eq,
  ociManifests,
  packages,
  packageVersions,
  repositories,
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
  type AvailableScanners,
  detectScanners,
  osvScanDependencies,
  runExternalScanners,
  type ScannerRuntimeOptions,
  scanDependencies,
  scanForMalware,
  scannerOptionsFromEnv,
} from "@hootifactory/scanning";
import { blobStore } from "@hootifactory/storage";
import { ociManifestReferences } from "@hootifactory/types";
import { collectPackageDependencies } from "./scan-dependencies";
import { dedupeFindings } from "./scan-policy";
import { applyPolicyDecision, markSkippedClean, persistScanResult } from "./scan-results";

export { dedupeFindings } from "./scan-policy";
export { recordScanFailure } from "./scan-results";

const OCI_FORMATS = new Set(["docker", "oci", "helm"]);

export function externalContentScannerRequired(options: ScannerRuntimeOptions): boolean {
  return (
    Boolean(options.clamavRestUrl) ||
    Boolean(options.trivyServerUrl) ||
    (options.cliRuntime ?? "docker") !== "disabled"
  );
}

export function externalContentScannerAvailable(scanners: AvailableScanners): boolean {
  return scanners.grype || scanners.trivy || scanners.clamav;
}

export function shouldFailForMissingExternalScanner(
  options: ScannerRuntimeOptions,
  scanners: AvailableScanners,
): boolean {
  return externalContentScannerRequired(options) && !externalContentScannerAvailable(scanners);
}

export interface ScannerRuntime {
  scannerOptions: ScannerRuntimeOptions;
  scanners: AvailableScanners;
}

export function scannerRuntimeFromEnv(): ScannerRuntime {
  const scannerOptions = scannerOptionsFromEnv();
  return { scannerOptions, scanners: detectScanners(scannerOptions) };
}

function unavailableExternalScannerMessage(options: ScannerRuntimeOptions): string {
  return [
    "external scanner runtime is configured but no content scanner is available",
    `(SCANNER_CLI_RUNTIME=${options.cliRuntime ?? "docker"})`,
    "set SCANNER_CLI_RUNTIME=disabled for heuristic-only scanning or configure Grype, Trivy, or ClamAV",
  ].join("; ");
}

/** Run the scan pipeline for one artifact and apply the policy decision. */
export async function processScan(
  artifactId: string,
  scannerRuntime: ScannerRuntime = scannerRuntimeFromEnv(),
): Promise<void> {
  await withLogAttributes({ "artifact.id": artifactId }, async () => {
    await withSpan("scan.process_artifact", { "artifact.id": artifactId }, async () => {
      await processScanInner(artifactId, scannerRuntime);
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

async function processScanInner(artifactId: string, scannerRuntime: ScannerRuntime): Promise<void> {
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
  const scannedBlobDigests = new Set<string>();
  await withSpan("scan.heuristic_dependencies", {}, async (span) => {
    const dependencyFindings = scanDependencies(deps);
    found.push(...dependencyFindings);
    span.setAttribute("scan.findings.count", dependencyFindings.length);
  });

  let scannedBytePayload = false;
  async function scanStoredBytes(digest: string): Promise<boolean> {
    if (scannedBlobDigests.has(digest)) return true;
    scannedBlobDigests.add(digest);
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
      span.setAttributes({
        "scan.external.grype": Boolean(scannerRuntime.scanners.grype),
        "scan.external.trivy": Boolean(scannerRuntime.scanners.trivy),
        "scan.external.clamav": Boolean(scannerRuntime.scanners.clamav),
      });
      if (
        shouldFailForMissingExternalScanner(scannerRuntime.scannerOptions, scannerRuntime.scanners)
      ) {
        const message = unavailableExternalScannerMessage(scannerRuntime.scannerOptions);
        addSpanEvent("scan.external_unavailable", {
          "scan.cli_runtime": scannerRuntime.scannerOptions.cliRuntime ?? "docker",
        });
        logger.warn("external scanner runtime unavailable", {
          cliRuntime: scannerRuntime.scannerOptions.cliRuntime ?? "docker",
          scanners: scannerRuntime.scanners,
        });
        throw new Error(message);
      }
      if (
        scannerRuntime.scanners.grype ||
        scannerRuntime.scanners.trivy ||
        scannerRuntime.scanners.clamav
      ) {
        let dir: string | null = null;
        try {
          const base = env.SCAN_SCRATCH_DIR.replace(/\/+$/, "");
          await mkdir(base, { recursive: true });
          dir = await mkdtemp(join(base, "scan-"));
          const path = join(dir, digest.replace(/[^a-z0-9]/gi, "_"));
          await Bun.write(path, bytes);
          const externalFindings = await runExternalScanners(
            path,
            bytes,
            scannerRuntime.scannerOptions,
            scannerRuntime.scanners,
          );
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

  await persistScanResult(art, results, scannerRuntime.scanners);
  await applyPolicyDecision(art, repo, results);
}
