import { env } from "@hootifactory/config";
import { createAsyncLimiter, mapWithBoundedConcurrency } from "@hootifactory/core";
import { and, artifacts, db, eq, packages, packageVersions, repositories } from "@hootifactory/db";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withLogAttributes,
  withSpan,
} from "@hootifactory/observability";
import { type RegistryPlugin, registryPlugins } from "@hootifactory/registry";
import { loadContentAddressableManifestRaw } from "@hootifactory/registry-application/content";
import type { NormalizedFinding } from "@hootifactory/scan-core";
import { osvScanDependencies, scanDependencies } from "@hootifactory/scanning";
import { scanStoredBytes } from "./scan-bytes";
import { collectPackageDependencies } from "./scan-dependencies";
import { dedupeFindings } from "./scan-policy";
import { applyPolicyDecision, markSkippedClean, persistScanResult } from "./scan-results";
import { type ScannerRuntime, scannerRuntimeFromEnv } from "./scan-runtime";

export { dedupeFindings } from "./scan-policy";
export { recordScanFailure } from "./scan-results";
export {
  externalContentScannerRequired,
  scannerRuntimeFromEnv,
  shouldFailForMissingExternalScanner,
} from "./scan-runtime";
export { mapWithBoundedConcurrency };

const MANIFEST_REFERENCE_SCAN_CONCURRENCY = 3;

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
  module: RegistryPlugin;
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
    "registry.module.id": repo.moduleId,
    "registry.repository.id": repo.id,
    "registry.repository.name": repo.name,
  });
  const module = registryPlugins.lookup(repo.moduleId);
  if (!module) {
    addSpanEvent("scan.registry_module_missing", { "registry.module.id": repo.moduleId });
    throw new Error(`registry module is not registered: ${repo.moduleId}`);
  }
  logger.info("scan artifact started", {
    artifactId: art.id,
    digest: art.digest,
    repo: repo.name,
    moduleId: repo.moduleId,
  });
  return { art, repo, module };
}

async function processScanInner(artifactId: string, scannerRuntime: ScannerRuntime): Promise<void> {
  const context = await loadScanContext(artifactId);
  if (!context) return;
  const { art, repo, module } = context;
  const artName = art.name;
  const artVersion = art.version;
  const repoId = repo.id;

  const { deps, osvEcosystem, purlType } = await collectPackageDependencies({
    repositoryId: repo.id,
    module,
    artifactName: art.name,
    artifactVersion: art.version,
  });

  const found: NormalizedFinding[] = [];
  const scannedBlobDigests = new Set<string>();
  const scanReferencedBytes = createAsyncLimiter(MANIFEST_REFERENCE_SCAN_CONCURRENCY);
  const scanReferencedManifests = createAsyncLimiter(MANIFEST_REFERENCE_SCAN_CONCURRENCY);
  const manifestGraph = module.scan?.contentAddressableManifestGraph;
  await withSpan("scan.heuristic_dependencies", {}, async (span) => {
    const dependencyFindings = scanDependencies(deps, { purlType });
    found.push(...dependencyFindings);
    span.setAttribute("scan.findings.count", dependencyFindings.length);
  });

  let scannedBytePayload = false;
  async function scanArtifactBytes(
    digest: string,
    opts: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    const result = await scanStoredBytes({
      digest,
      scannerRuntime,
      scannedBlobDigests,
      allowMissing: opts.allowMissing,
    });
    found.push(...result.findings);
    if (result.scannedPayload) scannedBytePayload = true;
    return result.available;
  }

  async function scanContentAddressableManifestReferences(digest: string): Promise<number | null> {
    const graph = manifestGraph;
    if (!graph) return null;
    const references = graph.references;
    const seen = new Set<string>();
    const queue = [digest];
    let next = 0;
    let rootFound = false;
    let referenceCount = 0;

    async function scanQueuedManifest(manifestDigest: string): Promise<void> {
      return withSpan(
        "scan.manifest_graph",
        { "artifact.digest": manifestDigest },
        async (span) => {
          if (seen.has(manifestDigest)) {
            span.setAttribute("scan.manifest_graph.seen", true);
            return;
          }
          seen.add(manifestDigest);
          const manifest = await loadContentAddressableManifestRaw({
            repositoryId: repoId,
            digest: manifestDigest,
          });
          if (!manifest) {
            span.setAttribute("scan.manifest_graph.found", false);
            return;
          }
          if (manifestDigest === digest) rootFound = true;
          span.setAttribute("scan.manifest_graph.found", true);
          const refs = references(manifest.raw);
          span.setAttributes({
            "scan.manifest_graph.blob_refs": refs.blobs.length,
            "scan.manifest_graph.manifest_refs": refs.manifests.length,
          });
          referenceCount += refs.blobs.length + refs.manifests.length;
          await mapWithBoundedConcurrency(
            refs.blobs,
            MANIFEST_REFERENCE_SCAN_CONCURRENCY,
            (blobDigest) => scanReferencedBytes(() => scanArtifactBytes(blobDigest)),
          );
          for (const childDigest of refs.manifests) {
            if (!seen.has(childDigest)) queue.push(childDigest);
          }
          span.setAttribute("scan.manifest_graph.reference_count", referenceCount);
        },
      );
    }

    await Promise.all(
      Array.from({ length: MANIFEST_REFERENCE_SCAN_CONCURRENCY }, async () => {
        while (next < queue.length) {
          const index = next;
          next += 1;
          const manifestDigest = queue[index];
          if (manifestDigest)
            await scanReferencedManifests(() => scanQueuedManifest(manifestDigest));
        }
      }),
    );

    if (!rootFound) return null;
    return withSpan(
      "scan.manifest_reference_summary",
      { "artifact.digest": digest },
      async (span) => {
        if (seen.has(digest)) {
          span.setAttribute("scan.manifest_graph.unique_count", seen.size);
        }
        span.setAttribute("scan.manifest_graph.reference_count", referenceCount);
        return referenceCount;
      },
    );
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

  const scansManifestGraph = Boolean(manifestGraph);
  const scannedDirectBytes = await scanArtifactBytes(art.digest, {
    allowMissing: scansManifestGraph,
  });
  let scannedManifestGraph = false;
  let manifestReferenceCount = 0;
  if (!scannedDirectBytes && scansManifestGraph) {
    const refs = await scanContentAddressableManifestReferences(art.digest);
    scannedManifestGraph = refs !== null;
    manifestReferenceCount = refs ?? 0;
  }
  if (!scannedBytePayload && Object.keys(deps).length === 0) {
    if (await isDeletedPackageVersion()) {
      await markSkippedClean(art, "package_version_deleted");
      return;
    }
    if (scannedManifestGraph && manifestReferenceCount === 0) {
      await markSkippedClean(
        art,
        manifestGraph?.noPayloadReason ?? "manifest_graph_no_scannable_payload",
      );
      return;
    }
    throw new Error(`no scannable bytes available for artifact ${art.digest}`);
  }
  if (env.SCANNER_OSV && osvEcosystem) {
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
