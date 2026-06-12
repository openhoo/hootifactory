import {
  type Action,
  createRequestAuthorizer,
  type Principal,
  type ResourceRef,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { addSpanEvent, logger, withSpan } from "@hootifactory/observability";
import type {
  EnqueueScanInput,
  RegistryDataService,
  RegistryRequestContext,
  ResolvedRepo,
} from "@hootifactory/registry";
import { createRegistryDataService } from "./data-service";
import { recordArtifactScanOutbox } from "./scan-outbox";

export { recordArtifactScanOutbox, scanOutboxResetGuard } from "./scan-outbox";

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
