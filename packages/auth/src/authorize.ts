import type { PermissionKey } from "@hootifactory/types";
import { can } from "./can";
import { memoizeByKey } from "./memo";
import { permissionGrantsForToken, permissionGrantsForUser } from "./permission-grants";
import { type Action, permissionForAction } from "./permissions";
import type { Decision, Principal, ResourceRef } from "./principal";

async function grantsForPrincipal(principal: Principal, resource: ResourceRef) {
  if (principal.kind === "user") {
    return permissionGrantsForUser(principal.userId, resource.orgId ?? null);
  }
  if (principal.kind === "token") {
    return permissionGrantsForToken(principal.tokenId);
  }
  return [];
}

export async function effectivePermissionGrantsFor(principal: Principal, resource: ResourceRef) {
  return grantsForPrincipal(principal, resource);
}

export async function authorizePermission(
  principal: Principal,
  permission: PermissionKey,
  resource: ResourceRef,
): Promise<Decision> {
  const grants = await grantsForPrincipal(principal, resource);
  const decision = can({ principal, permission, resource, grants });
  if (!decision.allowed || principal.kind !== "token" || !principal.ownerUserId) return decision;

  const ownerGrants = await permissionGrantsForUser(principal.ownerUserId, resource.orgId ?? null);
  const ownerDecision = can({
    principal: {
      kind: "user",
      userId: principal.ownerUserId,
      username: principal.ownerUsername ?? "token-owner",
    },
    permission,
    resource,
    grants: ownerGrants,
  });
  if (ownerDecision.allowed) return decision;
  return {
    allowed: false,
    code: "insufficient_scope",
    reason: "token owner no longer has the required permission",
  };
}

/** DB-backed authorization: resolve grants, then apply the pure can(). */
export async function authorize(
  principal: Principal,
  action: Action,
  resource: ResourceRef,
): Promise<Decision> {
  const permission = permissionForAction(action, resource);
  const grants = await grantsForPrincipal(principal, resource);
  const decision = can({ principal, action, permission, resource, grants });
  if (!decision.allowed || principal.kind !== "token" || !principal.ownerUserId) return decision;

  const ownerGrants = await permissionGrantsForUser(principal.ownerUserId, resource.orgId ?? null);
  const ownerDecision = can({
    principal: {
      kind: "user",
      userId: principal.ownerUserId,
      username: principal.ownerUsername ?? "token-owner",
    },
    action,
    permission,
    resource,
    grants: ownerGrants,
  });
  if (ownerDecision.allowed) return decision;
  return {
    allowed: false,
    code: "insufficient_scope",
    reason: "token owner no longer has the required permission",
  };
}

function principalPermissionCacheKey(principal: Principal): string {
  if (principal.kind === "user") return `user:${principal.userId}`;
  if (principal.kind === "token") {
    return `token:${principal.tokenId}:${principal.ownerUserId ?? ""}`;
  }
  if (principal.kind === "registryToken") return `registry:${principal.subject}`;
  return principal.kind;
}

function resourcePermissionCacheKey(
  principal: Principal,
  permission: PermissionKey,
  resource: ResourceRef,
): string {
  return [
    principalPermissionCacheKey(principal),
    permission,
    resource.orgId ?? "",
    resource.repositoryId ?? "",
    resource.repositoryName ?? "",
    resource.packageName ?? "",
    resource.artifactRef ?? "",
    resource.policy ?? "",
    resource.tokenTarget ?? "",
    resource.tokenId ?? "",
  ].join("\0");
}

export function createRequestAuthorizer(
  principal: Principal,
): (action: Action, resource: ResourceRef) => Promise<Decision> {
  const resourcesByKey = new Map<string, { action: Action; resource: ResourceRef }>();
  const decisionsByKey = memoizeByKey((key: string) => {
    const cached = resourcesByKey.get(key);
    if (!cached) throw new Error("missing authorization resource cache entry");
    return authorize(principal, cached.action, cached.resource);
  });

  return async (action: Action, resource: ResourceRef) => {
    const permission = permissionForAction(action, resource);
    const key = resourcePermissionCacheKey(principal, permission, resource);
    resourcesByKey.set(key, { action, resource });
    return decisionsByKey(key);
  };
}
