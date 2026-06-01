import { authorize, issueRegistryToken, type RegistryAccess } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { REGISTRY_TOKEN_SERVICE, resolveRepository, z, zodIssueTree } from "@hootifactory/core";
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

const TokenQuerySchema = z.strictObject({
  service: z.string().min(1).max(512).optional(),
  scopes: z.array(z.string().min(1).max(4096)).max(100),
});

const DockerScopeSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((scope, ctx) => {
    const firstColon = scope.indexOf(":");
    const lastColon = scope.lastIndexOf(":");
    if (firstColon < 0 || lastColon <= firstColon) {
      ctx.addIssue({ code: "custom", message: "scope must be type:name:actions" });
      return z.NEVER;
    }
    const type = scope.slice(0, firstColon);
    const name = scope.slice(firstColon + 1, lastColon);
    const requested = scope
      .slice(lastColon + 1)
      .split(",")
      .filter(Boolean);
    if (type !== "repository") {
      ctx.addIssue({ code: "custom", message: "scope type must be repository" });
      return z.NEVER;
    }
    if (!name || name.length > 512 || name.includes("..") || name.startsWith("/")) {
      ctx.addIssue({ code: "custom", message: "scope repository name is invalid" });
      return z.NEVER;
    }
    if (requested.length === 0 || requested.length > 4) {
      ctx.addIssue({ code: "custom", message: "scope actions are invalid" });
      return z.NEVER;
    }
    for (const action of requested) {
      if (!["pull", "push", "delete", "*"].includes(action)) {
        ctx.addIssue({ code: "custom", message: `unsupported scope action '${action}'` });
        return z.NEVER;
      }
    }
    return { type, name, requested };
  });

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
  const rawScopes = query.data.scopes.flatMap((s) => s.split(" ")).filter(Boolean);
  const scopeList = z.array(DockerScopeSchema).safeParse(rawScopes);
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
