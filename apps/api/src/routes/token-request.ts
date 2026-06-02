import { zodIssueTree } from "@hootifactory/core";
import { type DockerScope, parseDockerScopes, TokenQuerySchema } from "./token-scopes";

export interface TokenRequestQuery {
  service?: string;
  scopes: DockerScope[];
}

export type TokenRequestQueryResult =
  | { ok: true; data: TokenRequestQuery }
  | {
      ok: false;
      status: 400;
      body: {
        errors: Array<{ code: "BAD_REQUEST"; message: string; detail?: unknown }>;
      };
    };

function badTokenRequest(message: string, detail?: unknown): TokenRequestQueryResult {
  return {
    ok: false,
    status: 400,
    body: { errors: [{ code: "BAD_REQUEST", message, detail }] },
  };
}

export function parseTokenRequestQuery(url: URL): TokenRequestQueryResult {
  const services = url.searchParams.getAll("service");
  if (services.length > 1) {
    return badTokenRequest("service may only be supplied once");
  }
  const query = TokenQuerySchema.safeParse({
    service: services[0],
    scopes: url.searchParams.getAll("scope"),
  });
  if (!query.success) {
    return badTokenRequest("invalid token query", zodIssueTree(query.error));
  }
  const scopeList = parseDockerScopes(query.data.scopes);
  if (!scopeList.success) {
    return badTokenRequest("invalid token scope", zodIssueTree(scopeList.error));
  }
  return { ok: true, data: { service: query.data.service, scopes: scopeList.data } };
}
