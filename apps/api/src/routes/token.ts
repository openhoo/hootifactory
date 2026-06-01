import { authorize, issueRegistryToken, type RegistryAccess } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { REGISTRY_TOKEN_SERVICE, resolveRepository } from "@hootifactory/core";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withSpan,
} from "@hootifactory/observability";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const tokenRouter = new Hono<AppEnv>();

function dockerToRbac(action: string): "read" | "write" | "delete" | null {
  if (action === "pull") return "read";
  if (action === "push") return "write";
  if (action === "delete") return "delete";
  return null;
}

/**
 * OCI token endpoint. Authorizes each requested `repository:<name>:<actions>`
 * scope against RBAC and mints an RS256 Bearer JWT containing only the granted
 * actions. /v2 requests verify the JWT and check it covers the operation.
 */
async function handleToken(c: Context<AppEnv>): Promise<Response> {
  const principal = c.get("principal");
  const url = new URL(c.req.url);
  const scopeList = url.searchParams
    .getAll("scope")
    .flatMap((s) => s.split(" "))
    .filter(Boolean);
  const service = url.searchParams.get("service");
  setActiveSpanAttributes({
    "registry.token.scope_count": scopeList.length,
    "registry.token.service": service ?? "",
    "auth.principal.kind": principal.kind,
  });

  if ((scopeList.length > 0 || service !== null) && service !== REGISTRY_TOKEN_SERVICE) {
    addSpanEvent("registry.token.invalid_service", { "registry.token.service": service ?? "" });
    logger.warn("registry token request rejected for invalid service", {
      service,
      requestedScopes: scopeList.length,
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
  for (const scope of scopeList) {
    await withSpan("registry.token.scope", { "registry.token.scope": scope }, async (span) => {
      const firstColon = scope.indexOf(":");
      const lastColon = scope.lastIndexOf(":");
      if (firstColon < 0 || lastColon <= firstColon) {
        span.setAttribute("registry.token.scope.valid", false);
        return;
      }
      const type = scope.slice(0, firstColon);
      const name = scope.slice(firstColon + 1, lastColon);
      const requested = scope
        .slice(lastColon + 1)
        .split(",")
        .filter(Boolean);
      span.setAttributes({
        "registry.token.scope.type": type,
        "registry.repository.name": name,
        "registry.token.requested_actions": requested.join(","),
      });
      if (type !== "repository") return;

      const granted: string[] = [];
      const resolution = await resolveRepository(`/v2/${name}`);
      span.setAttribute("registry.repository.resolved", Boolean(resolution));
      if (resolution) {
        const { repo } = resolution;
        const wantActions = requested.flatMap((a) =>
          a === "*" ? ["pull", "push", "delete"] : [a],
        );
        for (const da of wantActions) {
          const rbac = dockerToRbac(da);
          if (!rbac) continue;
          const decision = await authorize(principal, rbac, {
            type: "repository",
            orgId: repo.orgId,
            repositoryId: repo.id,
            repositoryName: name,
            visibility: repo.visibility,
          });
          if (decision.allowed && !granted.includes(da)) granted.push(da);
        }
      }
      span.setAttribute("registry.token.granted_actions", granted.join(","));
      access.push({ type: "repository", name, actions: granted });
    });
  }

  // No-scope login probe: require valid credentials.
  if (scopeList.length === 0 && principal.kind === "anonymous") {
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
    scopeCount: scopeList.length,
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
