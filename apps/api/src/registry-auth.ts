import { type Decision, httpStatusForDenial } from "@hootifactory/auth";
import { logger } from "@hootifactory/observability";
import type {
  HttpMethod,
  Permission,
  RegistryPlugin,
  RegistryRequestContext,
  ResolvedRepo,
  RouteMatch,
} from "@hootifactory/registry";
import type { registryErrorResponseForModule } from "./registry-error-format";
import type { RegistryAuthFailure } from "./types";

export interface RouteAuthorization {
  permission: Permission;
  decision: Decision;
  repositoryName: string;
}

export async function authorizeRoute(
  adapter: RegistryPlugin,
  method: HttpMethod,
  match: RouteMatch,
  ctx: RegistryRequestContext,
): Promise<RouteAuthorization> {
  const permission = adapter.requiredPermission(method, match, ctx);
  const repositoryName = permission.repositoryName ?? ctx.repo.name;
  const decision = await ctx.authorize(permission.action, {
    repositoryName,
    ...permission.resource,
  });
  return { permission, decision, repositoryName };
}

export function appendBearerChallengeError(
  header: string,
  error?: "invalid_token" | "insufficient_scope",
) {
  return error ? `${header},error="${error}"` : header;
}

type RegistryErrorResponseInput = Parameters<typeof registryErrorResponseForModule>[1];

export interface RegistryAuthorizationDenialInput {
  repo: ResolvedRepo;
  adapter: RegistryPlugin;
  ctx: RegistryRequestContext;
  principal: RegistryRequestContext["principal"];
  decision: Decision;
  permission: Permission;
  registryAuthFailure?: RegistryAuthFailure;
  deny(input: RegistryErrorResponseInput): Response;
}

export function registryAuthorizationDeniedResponse({
  repo,
  adapter,
  ctx,
  principal,
  decision,
  permission,
  registryAuthFailure,
  deny,
}: RegistryAuthorizationDenialInput): Response {
  const status = httpStatusForDenial(decision);
  const bearerError =
    registryAuthFailure ??
    (principal.kind === "registryToken" && decision.code === "insufficient_scope"
      ? "insufficient_scope"
      : undefined);
  logger.debug("registry authorization denied", {
    repo: repo.name,
    moduleId: repo.moduleId,
    action: permission.action,
    status,
    reason: decision.reason ?? decision.code,
  });
  if ((status === 401 || bearerError === "insufficient_scope") && adapter.authChallenge) {
    const challenge = adapter.authChallenge(permission, ctx);
    return deny({
      status: challenge.status,
      code: "UNAUTHORIZED",
      message: decision.reason ?? "authentication required",
      headers: {
        "www-authenticate": appendBearerChallengeError(challenge.header, bearerError),
      },
    });
  }
  return deny({
    status,
    code: status === 401 ? "UNAUTHORIZED" : "DENIED",
    message: decision.reason ?? (status === 401 ? "authentication required" : "access denied"),
  });
}
