import {
  artifacts,
  db,
  eq,
  findings as findingsTable,
  type repositories,
  scans,
} from "@hootifactory/db";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withSpan,
} from "@hootifactory/observability";
import {
  ARTIFACT_STATE,
  type NormalizedFinding,
  SCAN_STATUS,
  SCAN_TYPE,
} from "@hootifactory/scan-core";
import type { AvailableScanners } from "@hootifactory/scanning";
import { evaluateScanPolicy, loadPolicy } from "./scan-policy";

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
  scanType: SCAN_TYPE.vulnerability,
  scanner: "hootifactory-heuristic",
  scannerVersion: "1",
  dbVersion: "builtin",
} as const;

/** Upsert the per-artifact scan row and replace its findings with `results`. */
export async function persistScanResult(
  art: typeof artifacts.$inferSelect,
  results: NormalizedFinding[],
  scanners: AvailableScanners,
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
          status: SCAN_STATUS.succeeded,
          startedAt: new Date(),
          finishedAt: new Date(),
          sbomNativeJson: {
            scanners,
          },
        })
        .onConflictDoUpdate({
          target: SCAN_CONFLICT_TARGET,
          set: { status: SCAN_STATUS.succeeded, error: null, finishedAt: new Date() },
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
export async function applyPolicyDecision(
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
export async function markSkippedClean(
  art: typeof artifacts.$inferSelect,
  reason: string,
): Promise<void> {
  addSpanEvent("scan.skipped", { "scan.skip_reason": reason });
  await db
    .update(artifacts)
    .set({
      state: ARTIFACT_STATE.clean,
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
      status: SCAN_STATUS.failed,
      error: message,
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: SCAN_CONFLICT_TARGET,
      set: { status: SCAN_STATUS.failed, error: message, finishedAt: new Date() },
    });
  await db
    .update(artifacts)
    .set({
      policyDecision: {
        scanStatus: SCAN_STATUS.failed,
        error: message,
        failedAt: new Date().toISOString(),
      },
    })
    .where(eq(artifacts.id, art.id));
  logger.warn("scan failure recorded", { artifactId, digest: art.digest, error: message });
}
