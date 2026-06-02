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

  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  let role: RoleName | null = member?.role ?? null;

  const orgBindingRole = await roleBindingRole({ userId }, orgId);
  if (orgBindingRole) role = role ? maxRole(role, orgBindingRole) : orgBindingRole;

  const externalGrants = await db
    .select({ role: externalRoleGrants.role })
    .from(externalRoleGrants)
    .where(and(eq(externalRoleGrants.userId, userId), eq(externalRoleGrants.orgId, orgId)));
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
    if (principal.tokenId) {
      const tokenId = principal.tokenId;
      role =
        (resource.repositoryId
          ? await roleBindingRole({ tokenId }, resource.orgId, resource.repositoryId)
          : null) ?? (await roleBindingRole({ tokenId }, resource.orgId));
    }

    role ??= principal.role;
    if (principal.ownerUserId) {
      const ownerRole = await resolveUserRole(
        principal.ownerUserId,
        resource.orgId,
        resource.repositoryId,
      );
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
