import { type Action, authorize, type Principal, type ResourceRef } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { artifacts, db, eq } from "@hootifactory/db";
import {
  addSpanEvent,
  captureTelemetryContext,
  logger,
  withSpan,
} from "@hootifactory/observability";
import { enqueue, QUEUES } from "@hootifactory/queue";
import type {
  EnqueueScanInput,
  RegistryRequestContext,
  ResolvedRepo,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      const [artifact] = await db
        .insert(artifacts)
        .values({
          orgId: repo.orgId,
          repositoryId: repo.id,
          digest: input.digest,
          mediaType: input.mediaType,
          name: input.name,
          version: input.version,
          state: "pending",
        })
        .onConflictDoUpdate({
          target: [artifacts.orgId, artifacts.repositoryId, artifacts.digest],
          set: { name: input.name, version: input.version, state: "pending" },
        })
        .returning({ id: artifacts.id });
      if (!artifact) {
        addSpanEvent("scan.enqueue.no_artifact_row");
        return;
      }

      span.setAttribute("artifact.id", artifact.id);
      try {
        await enqueue(
          QUEUES.scanArtifact,
          { artifactId: artifact.id, telemetry: captureTelemetryContext() },
          { retryLimit: 5, retryDelay: 30, retryBackoff: true },
        );
      } catch (err) {
        const error = errorText(err);
        await db
          .update(artifacts)
          .set({
            state: "quarantined",
            policyDecision: {
              scanStatus: "enqueue_failed",
              error: error.slice(0, 2000),
              failedAt: new Date().toISOString(),
            },
          })
          .where(eq(artifacts.id, artifact.id));
        throw err;
      }
      logger.debug("scan artifact enqueued", {
        artifactId: artifact.id,
        digest: input.digest,
        repo: repo.name,
      });
    },
  );
}

/** Assemble the per-request RegistryRequestContext injected into a format adapter. */
export function buildRegistryRequestContext(
  repo: ResolvedRepo,
  principal: Principal,
): RegistryRequestContext {
  return {
    repo,
    principal,
    blobs: blobStore,
    baseUrl: env.REGISTRY_PUBLIC_URL,
    limits: {
      maxUploadBytes: env.REGISTRY_MAX_UPLOAD_BYTES,
      enforcePublicNetwork: env.NODE_ENV === "production",
    },
    log: logger,
    authorize: (action: Action, resource?: Partial<ResourceRef>) =>
      authorize(principal, action, {
        type: "repository",
        orgId: repo.orgId,
        repositoryId: repo.id,
        repositoryName: repo.name,
        visibility: repo.visibility,
        ...resource,
      }),
    enqueueScan: (input: EnqueueScanInput) => enqueueArtifactScan(repo, input),
  };
}
