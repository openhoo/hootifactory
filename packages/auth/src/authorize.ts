import {
  and,
  db,
  eq,
  externalRoleGrants,
  isNull,
  memberships,
  roleBindings,
} from "@hootifactory/db";
import { can } from "./can";
import { memoizeByKey } from "./memo";
import { type Action, maxRole, minRole, type RoleName } from "./permissions";
import type { Decision, Principal, ResourceRef } from "./principal";

/**
 * Look up the role bound to a subject (user or token) for an org, optionally
 * scoped to a repository. When repositoryId is omitted the org-wide binding
 * (repositoryId IS NULL) is matched. Returns null when no binding exists.
 */
async function roleBindingRole(
  subject: { userId: string } | { tokenId: string },
  orgId: string,
  repositoryId?: string,
): Promise<RoleName | null> {
  const subjectFilter =
    "userId" in subject
      ? eq(roleBindings.userId, subject.userId)
      : eq(roleBindings.tokenId, subject.tokenId);
  const [row] = await db
    .select({ role: roleBindings.role })
    .from(roleBindings)
    .where(
      and(
        subjectFilter,
        eq(roleBindings.orgId, orgId),
        repositoryId
          ? eq(roleBindings.repositoryId, repositoryId)
          : isNull(roleBindings.repositoryId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

/**
 * Resolve a user's effective role for an org/repository.
 * Precedence: a repo-scoped binding wins outright; otherwise org membership is
 * combined with any org-wide binding (higher of the two).
 */
export async function resolveUserRole(
  userId: string,
  orgId: string,
  repositoryId?: string,
): Promise<RoleName | null> {
  if (repositoryId) {
    const repoBindingRole = await roleBindingRole({ userId }, orgId, repositoryId);
    if (repoBindingRole) return repoBindingRole;
  }

  const [memberRows, orgBindingRole, externalGrants] = await Promise.all([
    db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
      .limit(1),
    roleBindingRole({ userId }, orgId),
    db
      .select({ role: externalRoleGrants.role })
      .from(externalRoleGrants)
      .where(and(eq(externalRoleGrants.userId, userId), eq(externalRoleGrants.orgId, orgId))),
  ]);
  const [member] = memberRows;
  let role: RoleName | null = member?.role ?? null;

  if (orgBindingRole) role = role ? maxRole(role, orgBindingRole) : orgBindingRole;

  for (const grant of externalGrants) {
    role = role ? maxRole(role, grant.role) : grant.role;
  }

  return role;
}

export async function effectiveRoleFor(
  principal: Principal,
  resource: ResourceRef,
): Promise<RoleName | null> {
  if (principal.kind === "user") {
    if (!resource.orgId) return null;
    return resolveUserRole(principal.userId, resource.orgId, resource.repositoryId);
  }
  if (principal.kind === "token") {
    if (!resource.orgId) return principal.role;

    let role: RoleName | null = null;
    let ownerRole: RoleName | null = null;
    if (principal.tokenId) {
      const tokenId = principal.tokenId;
      const [repoBindingRole, orgBindingRole, resolvedOwnerRole] = await Promise.all([
        resource.repositoryId
          ? roleBindingRole({ tokenId }, resource.orgId, resource.repositoryId)
          : Promise.resolve(null),
        roleBindingRole({ tokenId }, resource.orgId),
        principal.ownerUserId
          ? resolveUserRole(principal.ownerUserId, resource.orgId, resource.repositoryId)
          : Promise.resolve(null),
      ]);
      role = repoBindingRole ?? orgBindingRole;
      ownerRole = resolvedOwnerRole;
    } else if (principal.ownerUserId) {
      ownerRole = await resolveUserRole(
        principal.ownerUserId,
        resource.orgId,
        resource.repositoryId,
      );
    }

    role ??= principal.role;
    if (principal.ownerUserId) {
      if (!role) return ownerRole;
      return ownerRole ? minRole(role, ownerRole) : null;
    }
    return role;
  }
  return null;
}

/** DB-backed authorization: resolve the effective role, then apply the pure can(). */
export async function authorize(
  principal: Principal,
  action: Action,
  resource: ResourceRef,
): Promise<Decision> {
  const effectiveRole = await effectiveRoleFor(principal, resource);
  return can({ principal, action, resource, effectiveRole });
}

function principalRoleCacheKey(principal: Principal): string {
  if (principal.kind === "user") return `user:${principal.userId}`;
  if (principal.kind === "token") {
    return `token:${principal.tokenId ?? ""}:${principal.ownerUserId ?? ""}:${principal.role ?? ""}`;
  }
  if (principal.kind === "registryToken") return `registry:${principal.subject}`;
  return principal.kind;
}

function resourceRoleCacheKey(principal: Principal, resource: ResourceRef): string {
  return [principalRoleCacheKey(principal), resource.orgId ?? "", resource.repositoryId ?? ""].join(
    "\0",
  );
}

export function createRequestAuthorizer(
  principal: Principal,
): (action: Action, resource: ResourceRef) => Promise<Decision> {
  const resourcesByKey = new Map<string, ResourceRef>();
  const effectiveRoleByKey = memoizeByKey((key: string) => {
    const resource = resourcesByKey.get(key);
    if (!resource) throw new Error("missing authorization resource cache entry");
    return effectiveRoleFor(principal, resource);
  });

  return async (action: Action, resource: ResourceRef) => {
    const key = resourceRoleCacheKey(principal, resource);
    resourcesByKey.set(key, resource);
    const effectiveRole = await effectiveRoleByKey(key);
    return can({ principal, action, resource, effectiveRole });
  };
}
