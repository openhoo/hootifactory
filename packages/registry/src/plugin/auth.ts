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

/**
 * Escape a value for inclusion in an HTTP `WWW-Authenticate` quoted-string
 * directive (RFC 7235 / RFC 7230 `quoted-string`). The repository name is
 * interpolated from unvalidated, URL-decoded request input, so a crafted name
 * could otherwise inject extra `"`/`,`-delimited challenge directives. Per the
 * grammar, only `"` and `\` need backslash-escaping inside a quoted-string.
 */
function escapeQuotedString(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

export function registryBearerAuthChallenge({
  ctx,
  permission,
  service = "hootifactory",
  realmPath = "/token",
}: RegistryBearerChallengeInput): { header: string; status: 401 } {
  const repositoryName = permission.repositoryName ?? ctx.repo.name;
  const actions = dockerScopeActions(permission.action);
  const realm = escapeQuotedString(`${ctx.baseUrl}${realmPath}`);
  const scope = escapeQuotedString(`repository:${repositoryName}:${actions}`);
  return {
    header: `Bearer realm="${realm}",service="${escapeQuotedString(service)}",scope="${scope}"`,
    status: 401,
  };
}
