import { issueRegistryToken, type RegistryAccess } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { REGISTRY_TOKEN_SERVICE, zodIssueTree } from "@hootifactory/core";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withSpan,
} from "@hootifactory/observability";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { grantDockerScope, parseDockerScopes, TokenQuerySchema } from "./token-scopes";

export const tokenRouter = new Hono<AppEnv>();

/**
 * OCI token endpoint. Authorizes each requested `repository:<name>:<actions>`
 * scope against RBAC and mints an RS256 Bearer JWT containing only the granted
 * actions. /v2 requests verify the JWT and check it covers the operation.
 */
async function handleToken(c: Context<AppEnv>): Promise<Response> {
  const principal = c.get("principal");
  const url = new URL(c.req.url);
  const services = url.searchParams.getAll("service");
  if (services.length > 1) {
    return c.json(
      { errors: [{ code: "BAD_REQUEST", message: "service may only be supplied once" }] },
      400,
    );
  }
  const query = TokenQuerySchema.safeParse({
    service: services[0],
    scopes: url.searchParams.getAll("scope"),
  });
  if (!query.success) {
    return c.json(
      {
        errors: [
          {
            code: "BAD_REQUEST",
            message: "invalid token query",
            detail: zodIssueTree(query.error),
          },
        ],
      },
      400,
    );
  }
  const scopeList = parseDockerScopes(query.data.scopes);
  if (!scopeList.success) {
    return c.json(
      {
        errors: [
          {
            code: "BAD_REQUEST",
            message: "invalid token scope",
            detail: zodIssueTree(scopeList.error),
          },
        ],
      },
      400,
    );
  }
  const service = query.data.service;
  setActiveSpanAttributes({
    "registry.token.scope_count": scopeList.data.length,
    "registry.token.service": service ?? "",
    "auth.principal.kind": principal.kind,
  });

  if ((scopeList.data.length > 0 || service !== undefined) && service !== REGISTRY_TOKEN_SERVICE) {
    addSpanEvent("registry.token.invalid_service", { "registry.token.service": service ?? "" });
    logger.warn("registry token request rejected for invalid service", {
      service,
      requestedScopes: scopeList.data.length,
    });
    return c.json(
      {
        errors: [
          {
            code: "UNAUTHORIZED",
            message: `invalid token service '${service ?? ""}'`,
          },
        ],
      },
      401,
    );
  }

  const access: RegistryAccess[] = [];
  for (const scope of scopeList.data) {
    await withSpan("registry.token.scope", { "registry.token.scope": scope.name }, async (span) => {
      const { type, name, requested } = scope;
      span.setAttributes({
        "registry.token.scope.type": type,
        "registry.repository.name": name,
        "registry.token.requested_actions": requested.join(","),
      });

      const grant = await grantDockerScope(principal, scope);
      span.setAttribute("registry.repository.resolved", grant.repositoryResolved);
      span.setAttribute("registry.token.granted_actions", grant.access.actions.join(","));
      access.push(grant.access);
    });
  }

  // No-scope login probe: require valid credentials.
  if (scopeList.data.length === 0 && principal.kind === "anonymous") {
    logger.debug("registry token login probe rejected anonymous principal");
    return c.json({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }, 401, {
      "www-authenticate": 'Basic realm="hootifactory"',
    });
  }

  const subject =
    principal.kind === "user"
      ? principal.username
      : principal.kind === "token"
        ? `token:${principal.tokenId}`
        : "anonymous";

  const token = await issueRegistryToken({
    subject,
    // Always the registry service name — the single source of truth that /v2
    // verification checks. Never the client-supplied `service` query param.
    audience: REGISTRY_TOKEN_SERVICE,
    access,
    ttlSeconds: env.REGISTRY_JWT_TTL,
  });
  logger.debug("registry token issued", {
    subject,
    scopeCount: scopeList.data.length,
    grantedScopes: access.length,
    ttlSeconds: env.REGISTRY_JWT_TTL,
  });

  return c.json({
    token,
    access_token: token,
    expires_in: env.REGISTRY_JWT_TTL,
    issued_at: new Date().toISOString(),
  });
}

tokenRouter.get("/", handleToken);
tokenRouter.post("/", handleToken);
