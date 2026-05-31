import { type Action, authorize, type Principal, type ResourceRef } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import type { RepoContext, ResolvedRepo } from "@hootifactory/core";
import { db } from "@hootifactory/db";
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
    enqueueScan: async () => {
      /* stub until Phase 3 */
    },
  };
}
