import {
  type Action,
  createRequestAuthorizer,
  type Principal,
  type ResourceRef,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { assertDigest } from "@hootifactory/core";
import { artifacts, db, ne, scanOutbox } from "@hootifactory/db";
import {
  addSpanEvent,
  captureTelemetryContext,
  logger,
  type TelemetryContextCarrier,
  withSpan,
} from "@hootifactory/observability";
import type {
  EnqueueScanInput,
  RegistryDataService,
  RegistryRequestContext,
  ResolvedRepo,
} from "@hootifactory/registry";
import { ARTIFACT_STATE, SCAN_OUTBOX_STATUS } from "@hootifactory/scan-core";
import type { Tx } from "../governance/quota";
import { createRegistryDataService } from "./data-service";

/**
 * Guard for the scan_outbox conflict-update: only reset a row to pending when it is
 * NOT currently being scanned. A 'processing' row is owned by a live worker, so a
 * concurrent re-publish must not clobber it back to pending (which would spawn a
 * duplicate scan and orphan the worker's claim). Exported for regression coverage.
 */
export function scanOutboxResetGuard() {
  return ne(scanOutbox.status, SCAN_OUTBOX_STATUS.processing);
}

/**
 * Idempotently record the artifact + its single scan_outbox row for (org, repo,
 * digest), resetting the outbox to pending and clearing locked_at/last_error. This
 * is the scan-queue idempotency boundary: re-publishing the same digest re-triggers
 * a scan rather than creating duplicates. Returns the artifact id, or null if no
 * row came back (which should not happen for an upsert with a RETURNING clause).
 * Not gated by SCANNER_ENABLED — the gate lives in enqueueArtifactScan.
 *
 * The outbox reset is guarded by `status <> 'processing'`: a re-publish landing
 * while a worker is mid-scan must NOT clobber the in-flight 'processing' row back
 * to 'pending'/clear locked_at, which would let a second worker claim it (duplicate
 * concurrent scans) and let the first worker's terminal write race the reset. The
 * in-flight attempt instead runs to completion and finalizes itself (the worker's
 * status-aware terminal write matches on its claimed attempt); the next publish or
 * reclaim re-triggers the rescan. This trades a slightly stale verdict for the
 * absence of duplicate scans and clobbered terminal writes.
 */
export async function recordArtifactScanOutbox(
  repo: ResolvedRepo,
  input: EnqueueScanInput,
  captureTelemetry: () => TelemetryContextCarrier = captureTelemetryContext,
  tx?: Tx,
): Promise<{ artifactId: string } | null> {
  // Defense-in-depth (issue #308): every current caller passes a server-computed
  // digest, but asserting the canonical "sha256:<64-hex>" shape here makes it an
  // invariant of the enqueue boundary — a malformed digest can never become an
  // artifacts/scan_outbox row (the throw happens before the transaction opens).
  assertDigest(input.digest);

  // Stamp the publish-time telemetry context on the outbox row (issue #341) so
  // the scan-worker can parent its scan spans to the publish trace, mirroring
  // the carrier pg-boss email jobs get at enqueue. Stored as NULL when there is
  // nothing to link (no active trace or correlation ids). `captureTelemetry` is
  // an injection seam for tests; production callers pass nothing.
  const captured = captureTelemetry();
  const telemetry =
    captured.trace || captured.requestId || captured.correlationId ? captured : null;

  const upsert = async (dbTx: Tx) => {
    const [row] = await dbTx
      .insert(artifacts)
      .values({
        orgId: repo.orgId,
        repositoryId: repo.id,
        digest: input.digest,
        mediaType: input.mediaType,
        name: input.name,
        version: input.version,
        state: ARTIFACT_STATE.pending,
      })
      .onConflictDoUpdate({
        target: [artifacts.orgId, artifacts.repositoryId, artifacts.digest],
        set: { name: input.name, version: input.version, state: ARTIFACT_STATE.pending },
      })
      .returning({ id: artifacts.id });
    if (!row) return null;
    await dbTx
      .insert(scanOutbox)
      .values({
        artifactId: row.id,
        status: SCAN_OUTBOX_STATUS.pending,
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lastError: null,
        telemetry,
      })
      .onConflictDoUpdate({
        target: [scanOutbox.artifactId],
        // Only reset a row that is not currently being scanned (see
        // scanOutboxResetGuard). The pending re-scan a re-publish of a 'processing'
        // row requests is recovered via reclaimStuckScans / the next publish.
        setWhere: scanOutboxResetGuard(),
        set: {
          status: SCAN_OUTBOX_STATUS.pending,
          nextAttemptAt: new Date(),
          lockedAt: null,
          lastError: null,
          // A re-publish re-triggers the scan, so the rescan should link to the
          // trace that requested it, not the original publish.
          telemetry,
          updatedAt: new Date(),
        },
      });
    return { artifactId: row.id };
  };

  return tx ? upsert(tx) : db.transaction(upsert);
}

async function enqueueArtifactScan(repo: ResolvedRepo, input: EnqueueScanInput): Promise<void> {
  if (!env.SCANNER_ENABLED) return;
  await withSpan(
    "scan.enqueue",
    {
      "artifact.digest": input.digest,
      "artifact.name": input.name ?? "",
      "artifact.version": input.version ?? "",
      "registry.repository.id": repo.id,
      "registry.repository.name": repo.name,
    },
    async (span) => {
      const artifact = await recordArtifactScanOutbox(repo, input);
      if (!artifact) {
        addSpanEvent("scan.enqueue.no_artifact_row");
        return;
      }

      span.setAttribute("artifact.id", artifact.artifactId);
      logger.debug("scan artifact outbox recorded", {
        artifactId: artifact.artifactId,
        digest: input.digest,
        repo: repo.name,
      });
    },
  );
}

/** Assemble the per-request RegistryRequestContext injected into a registry module. */
export function buildRegistryRequestContext(
  repo: ResolvedRepo,
  principal: Principal,
): RegistryRequestContext {
  const authorize = createRequestAuthorizer(principal);
  let data: RegistryDataService | undefined;
  const ctx: RegistryRequestContext = {
    repo,
    principal,
    // Lazily constructed on first access: the data service captures the fully
    // assembled ctx, and routes that never touch data skip building it.
    get data() {
      data ??= createRegistryDataService(ctx);
      return data;
    },
    baseUrl: env.REGISTRY_PUBLIC_URL,
    limits: {
      maxUploadBytes: env.REGISTRY_MAX_UPLOAD_BYTES,
      maxStagedUploadBytes: env.REGISTRY_MAX_STAGED_UPLOAD_BYTES,
      enforcePublicNetwork: !env.REGISTRY_ALLOW_PRIVATE_UPSTREAMS,
    },
    log: logger,
    authorize: (action: Action, resource?: Partial<ResourceRef>) =>
      authorize(action, {
        type: "repository",
        orgId: repo.orgId,
        repositoryId: repo.id,
        repositoryName: repo.name,
        visibility: repo.visibility,
        ...resource,
      }),
    enqueueScan: (input: EnqueueScanInput) => enqueueArtifactScan(repo, input),
  };
  return ctx;
}
