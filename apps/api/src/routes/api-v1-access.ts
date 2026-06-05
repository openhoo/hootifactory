import { authorize, createRequestAuthorizer } from "@hootifactory/auth";
import { mapWithBoundedConcurrency } from "@hootifactory/core";
import type { ResolvedRepo } from "@hootifactory/registry";
import {
  type ArtifactWithRepositoryRow,
  getArtifactWithRepository,
  getPackageWithRepository,
  type PackageWithRepositoryRow,
} from "@hootifactory/registry-application/inventory";
import {
  countRepositoriesForOrg,
  getRepositoryById,
  listRepositoriesForOrg,
} from "@hootifactory/registry-application/repositories";
import type { Action, PolicyName } from "@hootifactory/types";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { authorizationDenied, errorResponse } from "./api-v1-responses";

type ManagedPolicyName = Exclude<PolicyName, "*">;

export async function requireOrg(c: Context<AppEnv>, orgId: string, action: Action) {
  const decision = await authorize(c.get("principal"), action, { type: "org", orgId });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function repositoryById(repoId: string) {
  return getRepositoryById(repoId);
}

export async function authorizeRepository(c: Context<AppEnv>, repo: ResolvedRepo, action: Action) {
  const decision = await authorize(c.get("principal"), action, {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function requireRepository(
  c: Context<AppEnv>,
  repoId: string,
  action: Action,
): Promise<{ ok: true; repo: ResolvedRepo } | { ok: false; response: Response }> {
  const repo = await repositoryById(repoId);
  if (!repo)
    return { ok: false, response: errorResponse(c, 404, "NOT_FOUND", "repository not found") };
  const response = await authorizeRepository(c, repo, action);
  if (response) return { ok: false, response };
  return { ok: true, repo };
}

export async function packageWithRepository(packageId: string) {
  return getPackageWithRepository(packageId);
}

export async function authorizePackage(
  c: Context<AppEnv>,
  row: PackageWithRepositoryRow,
  action: Action,
) {
  const decision = await authorize(c.get("principal"), action, {
    type: "package",
    orgId: row.repo.orgId,
    repositoryId: row.repo.id,
    repositoryName: row.repo.name,
    packageName: row.pkg.name,
    visibility: row.repo.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function artifactWithRepository(artifactId: string) {
  return getArtifactWithRepository(artifactId);
}

export async function authorizeArtifact(
  c: Context<AppEnv>,
  row: ArtifactWithRepositoryRow,
  action: Action,
) {
  const decision = await authorize(c.get("principal"), action, {
    type: "artifact",
    orgId: row.repo.orgId,
    repositoryId: row.repo.id,
    repositoryName: row.repo.name,
    artifactRef: row.art.digest,
    visibility: row.repo.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function authorizeArtifactFindings(
  c: Context<AppEnv>,
  row: ArtifactWithRepositoryRow,
) {
  const decision = await authorize(c.get("principal"), "read", {
    type: "policy",
    orgId: row.repo.orgId,
    repositoryId: row.repo.id,
    repositoryName: row.repo.name,
    policy: "scan",
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function authorizePolicy(
  c: Context<AppEnv>,
  input: {
    orgId: string;
    policy: ManagedPolicyName;
    action: Action;
    repo?: ResolvedRepo;
  },
) {
  const decision = await authorize(c.get("principal"), input.action, {
    type: "policy",
    orgId: input.orgId,
    repositoryId: input.repo?.id,
    repositoryName: input.repo?.name,
    policy: input.policy,
    visibility: input.repo?.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function listAccessibleRepositories(
  orgId: string,
  c: Context<AppEnv>,
  pagination: { limit: number; offset: number },
) {
  const requestAuthorize = createRequestAuthorizer(c.get("principal"));
  const orgDecision = await requestAuthorize("read", { type: "org", orgId });
  if (orgDecision.allowed) {
    const [total, rows] = await Promise.all([
      countRepositoriesForOrg(orgId),
      listRepositoriesForOrg(orgId, pagination),
    ]);
    return { rows, total };
  }

  const rows = await listRepositoriesForOrg(orgId);
  // Each authorize resolves role bindings via the DB, so the previous serial loop
  // was O(n) sequential round-trips. Run them with bounded concurrency instead.
  // (An accurate `total` of accessible repos still requires scanning the org's
  // repos; pushing the visibility/role filter into SQL would be a larger follow-up.)
  const decisions = await mapWithBoundedConcurrency(rows, 16, (repo) =>
    requestAuthorize("read", {
      type: "repository",
      orgId: repo.orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
      visibility: repo.visibility,
    }),
  );
  const accessible = rows.filter((_, i) => decisions[i]?.allowed);
  return {
    rows: accessible.slice(pagination.offset, pagination.offset + pagination.limit),
    total: accessible.length,
  };
}
