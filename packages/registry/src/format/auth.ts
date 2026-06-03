import { basicAuthChallenge, type Permission, type RegistryRequestContext } from "./adapter";

export { basicAuthChallenge };

export function bearerAuthChallenge(realm = "hootifactory"): { header: string; status: 401 } {
  return { header: `Bearer realm="${realm}"`, status: 401 };
}

export interface RegistryBearerChallengeInput {
  ctx: RegistryRequestContext;
  permission: Permission;
  service?: string;
  realmPath?: string;
}

function dockerScopeActions(action: Permission["action"]): string {
  if (action === "read") return "pull";
  if (action === "delete") return "delete,pull";
  return "push,pull";
}

export function registryBearerAuthChallenge({
  ctx,
  permission,
  service = "hootifactory",
  realmPath = "/token",
}: RegistryBearerChallengeInput): { header: string; status: 401 } {
  const repositoryName = permission.repositoryName ?? ctx.repo.name;
  const actions = dockerScopeActions(permission.action);
  return {
    header: `Bearer realm="${ctx.baseUrl}${realmPath}",service="${service}",scope="repository:${repositoryName}:${actions}"`,
    status: 401,
  };
}
