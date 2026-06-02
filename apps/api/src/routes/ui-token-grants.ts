import { type RoleName, resolveUserRole, roleAllows, roleOutranks } from "@hootifactory/auth";
import { db, eq, repositories } from "@hootifactory/db";
import type { ParsedTokenScope } from "./ui-schemas";
import { scopeMayTargetRepo } from "./ui-token-scope";

interface TokenGrantRequest {
  userId: string;
  orgId: string;
  requestedRole?: RoleName;
  scopes: ParsedTokenScope[];
}

type TokenGrantResult = { ok: true } | { ok: false; error: string };

export async function validateTokenGrant({
  userId,
  orgId,
  requestedRole,
  scopes,
}: TokenGrantRequest): Promise<TokenGrantResult> {
  const creatorRole = await resolveUserRole(userId, orgId);
  if (requestedRole && (!creatorRole || roleOutranks(requestedRole, creatorRole))) {
    return { ok: false, error: "cannot grant a role above your own" };
  }

  const orgRepos =
    requestedRole || scopes.length
      ? await db
          .select({
            id: repositories.id,
            name: repositories.name,
            mountPath: repositories.mountPath,
          })
          .from(repositories)
          .where(eq(repositories.orgId, orgId))
      : [];

  if (requestedRole) {
    for (const repo of orgRepos) {
      const repoRole = await resolveUserRole(userId, orgId, repo.id);
      if (!repoRole || roleOutranks(requestedRole, repoRole)) {
        return {
          ok: false,
          error: `cannot grant role '${requestedRole}' on repository '${repo.name}'`,
        };
      }
    }
  }

  for (const scope of scopes) {
    for (const action of scope.actions) {
      if (!creatorRole || !roleAllows(creatorRole, action)) {
        return { ok: false, error: `cannot grant scope action '${action}' beyond your role` };
      }
    }
    for (const repo of orgRepos) {
      if (!scopeMayTargetRepo(scope.repository, repo)) continue;
      const repoRole = await resolveUserRole(userId, orgId, repo.id);
      for (const action of scope.actions) {
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
