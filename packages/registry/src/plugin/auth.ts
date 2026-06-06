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
 * grammar, `"` and `\` are backslash-escaped. Control characters (including
 * CR/LF, e.g. from a `%0d%0a` route param) are not valid `quoted-string` content
 * and are not escapable, so they are stripped rather than emitted into the
 * header value.
 */
function escapeQuotedString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch === '"' || ch === "\\" ? `\\${ch}` : ch;
  }
  return out;
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
