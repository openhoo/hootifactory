import {
  and,
  db,
  eq,
  isNotNull,
  repositories,
  roleBindings,
  type TokenGrant,
} from "@hootifactory/db";
import { resolveUserRole } from "./authorize";
import { type RoleName, roleAllows, roleOutranks } from "./permissions";
import { scopeMayTargetRepo } from "./scope";

interface TokenGrantRequest {
  userId: string;
  orgId: string;
  requestedRole?: RoleName;
  grants: TokenGrant[];
}

type TokenGrantResult = { ok: true } | { ok: false; error: string };

export async function validateTokenGrant({
  userId,
  orgId,
  requestedRole,
  grants,
}: TokenGrantRequest): Promise<TokenGrantResult> {
  const creatorRole = await resolveUserRole(userId, orgId);
  if (requestedRole && (!creatorRole || roleOutranks(requestedRole, creatorRole))) {
    return { ok: false, error: "cannot grant a role above your own" };
  }

  const orgRepos =
    requestedRole || grants.some((grant) => "repository" in grant && grant.repository)
      ? await db
          .select({
            id: repositories.id,
            name: repositories.name,
            mountPath: repositories.mountPath,
          })
          .from(repositories)
          .where(eq(repositories.orgId, orgId))
      : [];
  const repoRoleById =
    orgRepos.length > 0
      ? new Map(
          (
            await db
              .select({ repositoryId: roleBindings.repositoryId, role: roleBindings.role })
              .from(roleBindings)
              .where(
                and(
                  eq(roleBindings.userId, userId),
                  eq(roleBindings.orgId, orgId),
                  isNotNull(roleBindings.repositoryId),
                ),
              )
          ).flatMap((row) => (row.repositoryId ? [[row.repositoryId, row.role] as const] : [])),
        )
      : new Map<string, RoleName>();
  const effectiveRepoRole = (repoId: string): RoleName | null =>
    repoRoleById.get(repoId) ?? creatorRole;

  if (requestedRole) {
    for (const repo of orgRepos) {
      const repoRole = effectiveRepoRole(repo.id);
      if (!repoRole || roleOutranks(requestedRole, repoRole)) {
        return {
          ok: false,
          error: `cannot grant role '${requestedRole}' on repository '${repo.name}'`,
        };
      }
    }
  }

  for (const grant of grants) {
    for (const action of grant.actions) {
      if (!creatorRole || !roleAllows(creatorRole, action)) {
        return { ok: false, error: `cannot grant scope action '${action}' beyond your role` };
      }
    }
    if (!("repository" in grant) || !grant.repository) continue;
    for (const repo of orgRepos) {
      if (!scopeMayTargetRepo(grant.repository, repo)) continue;
      const repoRole = effectiveRepoRole(repo.id);
      for (const action of grant.actions) {
        if (!repoRole || !roleAllows(repoRole, action)) {
          return {
            ok: false,
            error: `cannot grant scope action '${action}' on repository '${repo.name}'`,
          };
        }
      }
    }
  }

  return { ok: true };
}
