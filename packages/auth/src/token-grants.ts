import { db, eq, repositories } from "@hootifactory/db";
import type { PermissionKey, TokenGrant } from "@hootifactory/types";
import { authorizePermission } from "./authorize";
import type { Principal, ResourceRef } from "./principal";
import { scopeMayTargetRepo } from "./scope";

interface TokenGrantRequest {
  principal: Principal;
  orgId: string;
  grants: TokenGrant[];
}

type TokenGrantResult = { ok: true } | { ok: false; error: string };

export function resourceForGrant(
  grant: TokenGrant,
  orgId: string,
  repo?: typeof repositories.$inferSelect,
): ResourceRef {
  if (grant.permission === "system.admin" || grant.permission.startsWith("user.")) {
    return { type: "system" };
  }
  if (grant.permission.startsWith("token.")) {
    return {
      type: "token",
      orgId,
      tokenTarget: grant.tokenTarget ?? "org",
      tokenId: grant.tokenId,
    };
  }
  if (grant.permission.startsWith("policy.")) {
    return {
      type: "policy",
      orgId,
      repositoryId: repo?.id,
      repositoryName: repo?.name,
      policy: grant.policy,
      visibility: repo?.visibility,
    };
  }
  if (grant.permission.startsWith("repository.")) {
    return {
      type: "repository",
      orgId,
      repositoryId: repo?.id,
      repositoryName: repo?.name ?? grant.repository,
      visibility: repo?.visibility,
    };
  }
  if (grant.permission.startsWith("package.")) {
    return {
      type: "package",
      orgId,
      repositoryId: repo?.id,
      repositoryName: repo?.name ?? grant.repository,
      packageName: grant.package ?? "*",
      visibility: repo?.visibility,
    };
  }
  if (grant.permission.startsWith("artifact.")) {
    return {
      type: "artifact",
      orgId,
      repositoryId: repo?.id,
      repositoryName: repo?.name ?? grant.repository,
      artifactRef: grant.artifact ?? "*",
      visibility: repo?.visibility,
    };
  }
  return { type: "org", orgId };
}

export async function canGrantPermission(
  principal: Principal,
  permission: PermissionKey,
  resource: ResourceRef,
): Promise<boolean> {
  if (principal.kind !== "user") return false;
  const decision = await authorizePermission(principal, permission, resource);
  return decision.allowed;
}

export async function validateAssignablePermissionGrants({
  principal,
  orgId,
  grants,
  allowSystemAdmin = false,
}: TokenGrantRequest & { allowSystemAdmin?: boolean }): Promise<TokenGrantResult> {
  if (principal.kind !== "user") return { ok: false, error: "login required" };
  const orgRepos = grants.some((grant) => grant.repository)
    ? await db.select().from(repositories).where(eq(repositories.orgId, orgId))
    : [];

  for (const grant of grants) {
    if (grant.permission === "system.admin" && !allowSystemAdmin) {
      return { ok: false, error: "system.admin cannot be granted through this flow" };
    }
    const matchingRepos = grant.repository
      ? orgRepos.filter((repo) => scopeMayTargetRepo(grant.repository!, repo))
      : [undefined];
    const targets = matchingRepos.length > 0 ? matchingRepos : [undefined];
    for (const repo of targets) {
      const resource = resourceForGrant(grant, orgId, repo);
      if (!(await canGrantPermission(principal, grant.permission, resource))) {
        return {
          ok: false,
          error: `cannot grant permission '${grant.permission}' beyond your own access`,
        };
      }
    }
  }

  return { ok: true };
}

export function validateTokenGrant(input: TokenGrantRequest): Promise<TokenGrantResult> {
  return validateAssignablePermissionGrants(input);
}
