import {
  type Action,
  createRequestAuthorizer,
  type Principal,
  type ResourceRef,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { artifacts, db, scanOutbox } from "@hootifactory/db";
import { addSpanEvent, logger, withSpan } from "@hootifactory/observability";
import type {
  EnqueueScanInput,
  RegistryRequestContext,
  ResolvedRepo,
} from "@hootifactory/registry";
import { createRegistryDataService } from "./data-service";

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
      const artifact = await db.transaction(async (tx) => {
        const [row] = await tx
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
        if (!row) return null;
        await tx
          .insert(scanOutbox)
          .values({
            artifactId: row.id,
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
            lockedAt: null,
            lastError: null,
          })
          .onConflictDoUpdate({
            target: [scanOutbox.artifactId],
            set: {
              status: "pending",
              nextAttemptAt: new Date(),
              lockedAt: null,
              lastError: null,
              updatedAt: new Date(),
            },
          });
        return row;
      });
      if (!artifact) {
        addSpanEvent("scan.enqueue.no_artifact_row");
        return;
      }

      span.setAttribute("artifact.id", artifact.id);
      logger.debug("scan artifact outbox recorded", {
        artifactId: artifact.id,
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
  const ctx: RegistryRequestContext = {
    repo,
    principal,
    data: undefined as never,
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
  ctx.data = createRegistryDataService(ctx);
  return ctx;
}
