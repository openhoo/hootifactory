import {
  type Action,
  type RegistryAccess,
  type RegistryAppRoute,
  type RegistryAppRouteContext,
  type RegistryPrincipal,
  z,
  zodIssueTree,
} from "@hootifactory/registry";

// ── Docker token scope grammar (OCI Distribution bearer auth) ───────────────

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

export type DockerScope = z.infer<typeof DockerScopeSchema>;

export function parseDockerScopes(rawScopes: string[]) {
  return z
    .array(DockerScopeSchema)
    .safeParse(rawScopes.flatMap((s) => s.split(" ")).filter(Boolean));
}

export function dockerToRbac(action: string): Action | null {
  if (action === "pull") return "read";
  if (action === "push") return "write";
  if (action === "delete") return "delete";
  return null;
}

export function requestedDockerActions(scope: DockerScope): string[] {
  return scope.requested.flatMap((action) =>
    action === "*" ? ["pull", "push", "delete"] : [action],
  );
}

export interface DockerScopeGrant {
  access: RegistryAccess;
  repositoryResolved: boolean;
}

export interface GrantDockerScopeDeps {
  authorize: RegistryAppRouteContext["authorize"];
  resolveRepository: RegistryAppRouteContext["resolveRepository"];
}

export async function grantDockerScope(
  principal: RegistryPrincipal,
  scope: DockerScope,
  deps: GrantDockerScopeDeps,
): Promise<DockerScopeGrant> {
  // The bearer claim carries generic RBAC actions; the agnostic verifier never
  // sees Docker pull/push/delete (translated here at mint time).
  const access: RegistryAccess = { type: "repository", name: scope.name, actions: [] };
  const resolution = await deps.resolveRepository(`/v2/${scope.name}`);
  if (!resolution) return { access, repositoryResolved: false };

  const { repo } = resolution;
  for (const dockerAction of requestedDockerActions(scope)) {
    const rbac = dockerToRbac(dockerAction);
    if (!rbac) continue;
    const decision = await deps.authorize(principal, rbac, {
      type: "repository",
      orgId: repo.orgId,
      repositoryId: repo.id,
      repositoryName: scope.name,
      visibility: repo.visibility,
    });
    if (decision.allowed && !access.actions.includes(rbac)) {
      access.actions.push(rbac);
    }
  }
  return { access, repositoryResolved: true };
}

// ── token request query parsing ─────────────────────────────────────────────

export interface TokenRequestQuery {
  service?: string;
  scopes: DockerScope[];
}

export type TokenRequestQueryResult =
  | { ok: true; data: TokenRequestQuery }
  | {
      ok: false;
      status: 400;
      body: { errors: Array<{ code: "BAD_REQUEST"; message: string; detail?: unknown }> };
    };

function badTokenRequest(message: string, detail?: unknown): TokenRequestQueryResult {
  return { ok: false, status: 400, body: { errors: [{ code: "BAD_REQUEST", message, detail }] } };
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

// ── app-level route handlers ────────────────────────────────────────────────

/** OCI Distribution API version check — GET/HEAD /v2 . */
function v2VersionCheck(): Response {
  return new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "docker-distribution-api-version": "registry/2.0",
    },
  });
}

/**
 * OCI token endpoint. Authorizes each requested `repository:<name>:<actions>`
 * scope against RBAC and mints a delegated registry Bearer token containing only
 * the granted (generic) actions. /v2 requests verify the token covers the op.
 */
async function handleToken(ctx: RegistryAppRouteContext): Promise<Response> {
  const { principal, url } = ctx;
  const parsedQuery = parseTokenRequestQuery(url);
  if (!parsedQuery.ok) {
    return Response.json(parsedQuery.body, { status: parsedQuery.status });
  }
  const { service, scopes } = parsedQuery.data;

  if ((scopes.length > 0 || service !== undefined) && service !== ctx.registryServiceName) {
    ctx.log.warn("registry token request rejected for invalid service", {
      service,
      requestedScopes: scopes.length,
    });
    return Response.json(
      { errors: [{ code: "UNAUTHORIZED", message: `invalid token service '${service ?? ""}'` }] },
      { status: 401 },
    );
  }

  const access: RegistryAccess[] = [];
  for (const scope of scopes) {
    const grant = await grantDockerScope(principal, scope, {
      authorize: ctx.authorize,
      resolveRepository: ctx.resolveRepository,
    });
    access.push(grant.access);
  }

  // No-scope login probe: require valid credentials.
  if (scopes.length === 0 && principal.kind === "anonymous") {
    ctx.log.debug("registry token login probe rejected anonymous principal");
    return Response.json(
      { errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] },
      { status: 401, headers: { "www-authenticate": 'Basic realm="hootifactory"' } },
    );
  }

  const subject =
    principal.kind === "user"
      ? principal.username
      : principal.kind === "token"
        ? `token:${principal.tokenId}`
        : "anonymous";

  const token = await ctx.issueBearerToken({
    subject,
    // Always the registry service name — the single source of truth that /v2
    // verification checks. Never the client-supplied `service` query param.
    audience: ctx.registryServiceName,
    access,
    ttlSeconds: ctx.bearerTokenTtlSeconds,
  });
  ctx.log.debug("registry token issued", {
    subject,
    scopeCount: scopes.length,
    grantedScopes: access.length,
    ttlSeconds: ctx.bearerTokenTtlSeconds,
  });

  return Response.json({
    token,
    access_token: token,
    expires_in: ctx.bearerTokenTtlSeconds,
    issued_at: new Date().toISOString(),
  });
}

/** The OCI/Docker protocol-prelude routes mounted outside the repo mount tree. */
export function ociAppRoutes(): RegistryAppRoute[] {
  return [
    { method: "GET", pattern: "/v2", handler: () => v2VersionCheck() },
    { method: "GET", pattern: "/v2/", handler: () => v2VersionCheck() },
    { method: "HEAD", pattern: "/v2", handler: () => v2VersionCheck() },
    { method: "HEAD", pattern: "/v2/", handler: () => v2VersionCheck() },
    { method: "GET", pattern: "/token", handler: handleToken },
    { method: "GET", pattern: "/token/", handler: handleToken },
    { method: "POST", pattern: "/token", handler: handleToken },
    { method: "POST", pattern: "/token/", handler: handleToken },
  ];
}
