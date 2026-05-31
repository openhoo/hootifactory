import { type Action, authorize, type Principal, type ResourceRef } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import type { EnqueueScanInput, RepoContext, ResolvedRepo } from "@hootifactory/core";
import { artifacts, db } from "@hootifactory/db";
import { enqueue, QUEUES } from "@hootifactory/queue";
import { blobStore } from "@hootifactory/storage";
import { logger } from "./lib/logger";

/** Assemble the per-request RepoContext injected into a format adapter. */
export function buildRepoContext(repo: ResolvedRepo, principal: Principal): RepoContext {
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
        // Bounded retry with backoff so a transient failure recovers but a
        // poisoned job can't retry-storm the queue.
        await enqueue(
          QUEUES.scanArtifact,
          { artifactId: artifact.id },
          { retryLimit: 5, retryDelay: 30, retryBackoff: true },
        );
      }
    },
  };
}
