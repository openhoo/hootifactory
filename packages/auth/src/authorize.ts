import { and, db, eq, isNull, memberships, roleBindings } from "@hootifactory/db";
import { can } from "./can";
import { type Action, maxRole, type RoleName } from "./permissions";
import type { Decision, Principal, ResourceRef } from "./principal";

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
    const [repoBinding] = await db
      .select({ role: roleBindings.role })
      .from(roleBindings)
      .where(and(eq(roleBindings.userId, userId), eq(roleBindings.repositoryId, repositoryId)))
      .limit(1);
    if (repoBinding) return repoBinding.role;
  }

  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  let role: RoleName | null = member?.role ?? null;

  const [orgBinding] = await db
    .select({ role: roleBindings.role })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.userId, userId),
        eq(roleBindings.orgId, orgId),
        isNull(roleBindings.repositoryId),
      ),
    )
    .limit(1);
  if (orgBinding) role = role ? maxRole(role, orgBinding.role) : orgBinding.role;

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
    if (principal.role) return principal.role;
    if (principal.ownerUserId && resource.orgId) {
      return resolveUserRole(principal.ownerUserId, resource.orgId, resource.repositoryId);
    }
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
