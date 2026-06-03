import { type Action, authorize, type Principal, type ResourceRef } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { artifacts, db, eq } from "@hootifactory/db";
import { addSpanEvent, captureTelemetryContext, withSpan } from "@hootifactory/observability";
import { enqueue, QUEUES } from "@hootifactory/queue";
import type {
  EnqueueScanInput,
  RegistryRequestContext,
  ResolvedRepo,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import { logger } from "./lib/logger";
import { errorMessage } from "./validation";

/** Assemble the per-request RegistryRequestContext injected into a format adapter. */
export function buildRegistryRequestContext(
  repo: ResolvedRepo,
  principal: Principal,
): RegistryRequestContext {
  return {
    repo,
    principal,
    db,
    blobs: blobStore,
    baseUrl: env.REGISTRY_PUBLIC_URL,
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
    enqueueScan: async (input: EnqueueScanInput) => {
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
          if (artifact) {
            span.setAttribute("artifact.id", artifact.id);
            // Bounded retry with backoff so a transient failure recovers but a
            // poisoned job can't retry-storm the queue.
            try {
              await enqueue(
                QUEUES.scanArtifact,
                { artifactId: artifact.id, telemetry: captureTelemetryContext() },
                { retryLimit: 5, retryDelay: 30, retryBackoff: true },
              );
            } catch (err) {
              const message = errorMessage(err);
              await db
                .update(artifacts)
                .set({
                  state: "quarantined",
                  policyDecision: {
                    scanStatus: "enqueue_failed",
                    error: message.slice(0, 2000),
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
          } else {
            addSpanEvent("scan.enqueue.no_artifact_row");
          }
        },
      );
    },
  };
}
