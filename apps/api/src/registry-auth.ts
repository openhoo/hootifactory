import type { Decision } from "@hootifactory/auth";
import type {
  FormatAdapter,
  HttpMethod,
  Permission,
  RepoContext,
  RouteMatch,
} from "@hootifactory/core";

export interface RouteAuthorization {
  permission: Permission;
  decision: Decision;
  repositoryName: string;
}

export async function authorizeRoute(
  adapter: FormatAdapter,
  method: HttpMethod,
  match: RouteMatch,
  ctx: RepoContext,
): Promise<RouteAuthorization> {
  const permission = adapter.requiredPermission(method, match, ctx);
  const repositoryName = permission.repositoryName ?? ctx.repo.name;
  const decision = await ctx.authorize(permission.action, { repositoryName });
  return { permission, decision, repositoryName };
}

export function appendBearerChallengeError(
  header: string,
  error?: "invalid_token" | "insufficient_scope",
) {
  return error ? `${header},error="${error}"` : header;
}
