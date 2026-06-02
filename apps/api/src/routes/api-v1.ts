import { authorize, createApiToken, revokeToken, rotateToken } from "@hootifactory/auth";
import {
  addUpstream,
  addVirtualMember,
  applyRetention,
  createRepository,
  isUniqueViolation,
} from "@hootifactory/core";
import {
  and,
  apiTokens,
  artifacts,
  count,
  db,
  desc,
  eq,
  findings,
  isNull,
  organizations,
  packages,
  packageVersions,
  quotas,
  repositories,
  scanPolicies,
  users,
} from "@hootifactory/db";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi";
import type { AppEnv } from "../types";
import {
  ArtifactIdParamsSchema,
  artifactWithRepository,
  authorizationDenied,
  authorizeArtifact,
  authorizePackage,
  authorizePolicy,
  authorizeRepository,
  dataResponse,
  doc,
  errorResponse,
  listAccessibleRepositories,
  listResponse,
  OrgIdParamsSchema,
  OrgTokenParamsSchema,
  PackageIdParamsSchema,
  packageWithRepository,
  principalActor,
  RepoIdParamsSchema,
  repositoryById,
  requireOrg,
  requireRepository,
  TokenIdParamsSchema,
  tokenResource,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { audit } from "./http";
import { repositoryDto, tokenDto } from "./ui-dto";
import { listAccessibleOrgs } from "./ui-orgs";
import { calculateOrgQuotaUsage, upsertOrgQuota } from "./ui-quota";
import { requireUserPrincipal } from "./ui-repository-access";
import { resolveCreateRepositoryRequest } from "./ui-repository-create";
import {
  AddMemberBodySchema,
  AddUpstreamBodySchema,
  CreateRepositoryBodySchema,
  CreateTokenV1BodySchema,
  isValidScanPolicyPattern,
  QuotaBodySchema,
  RetentionBodySchema,
  ScanPolicyBodySchema,
} from "./ui-schemas";
import { resolveCreateTokenRequest } from "./ui-token-create";
import { validateTokenGrant } from "./ui-token-grants";
import { validateProxyUpstreamParent, validateProxyUpstreamUrl } from "./ui-upstreams";
import { validateVirtualMemberCandidate, validateVirtualMemberParent } from "./ui-virtual-members";

export const apiV1Router = new Hono<AppEnv>();

apiV1Router.get("/docs", describeRoute({ hide: true }), (c) =>
  c.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hootifactory API v1</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #151515; }
      code, pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 6px; padding: .2rem .35rem; }
      li { margin: .35rem 0; }
      .method { display: inline-block; width: 4rem; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>Hootifactory API v1</h1>
    <p>Use <code>Authorization: Bearer &lt;token&gt;</code>. The machine-readable schema is at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>
    <ul id="paths"></ul>
    <script>
      fetch('/api/v1/openapi.json').then((r) => r.json()).then((spec) => {
        const list = document.getElementById('paths');
        for (const [path, methods] of Object.entries(spec.paths || {})) {
          for (const [method, op] of Object.entries(methods)) {
            const li = document.createElement('li');
            li.innerHTML = '<span class="method">' + method.toUpperCase() + '</span> <code>' + path + '</code> ' + (op.summary || '');
            list.appendChild(li);
          }
        }
      });
    </script>
  </body>
</html>`),
);

apiV1Router.get(
  "/openapi.json",
  describeRoute({ hide: true }),
  openAPIRouteHandler(apiV1Router, {
    documentation: {
      info: {
        title: "Hootifactory External API",
        version: "1.0.0",
      },
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
    exclude: ["/docs", "/openapi.json"],
  }),
);

apiV1Router.get("/me", doc("Inspect the current principal", "Identity"), (c) => {
  const principal = c.get("principal");
  if (principal.kind === "anonymous") {
    return errorResponse(c, 401, "UNAUTHENTICATED", "authentication required");
  }
  return dataResponse(c, { authenticated: true, principal });
});

apiV1Router.get("/orgs", doc("List accessible organizations", "Organizations"), async (c) => {
  const principal = c.get("principal");
  if (principal.kind === "user") return dataResponse(c, await listAccessibleOrgs(principal.userId));
  if (principal.kind === "token") {
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, principal.orgId))
      .limit(1);
    if (!org) return dataResponse(c, []);
    const response = await requireOrg(c, org.id, "read");
    return response ? response : dataResponse(c, [org]);
  }
  return errorResponse(c, 401, "UNAUTHENTICATED", "authentication required");
});

apiV1Router.get("/orgs/:orgId", doc("Get an organization", "Organizations"), async (c) => {
  const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const response = await requireOrg(c, params.data.orgId, "read");
  if (response) return response;
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, params.data.orgId))
    .limit(1);
  if (!org) return errorResponse(c, 404, "NOT_FOUND", "organization not found");
  return dataResponse(c, org);
});

apiV1Router.get(
  "/orgs/:orgId/repositories",
  doc("List repositories", "Repositories"),
  async (c) => {
    const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const pagination = validatePagination(c);
    if (!pagination.ok) return pagination.response;
    const rows = await listAccessibleRepositories(params.data.orgId, c);
    const page = rows.slice(pagination.data.offset, pagination.data.offset + pagination.data.limit);
    return listResponse(c, page.map(repositoryDto), {
      limit: pagination.data.limit,
      offset: pagination.data.offset,
      total: rows.length,
    });
  },
);

apiV1Router.post(
  "/orgs/:orgId/repositories",
  doc("Create a repository", "Repositories"),
  async (c) => {
    const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const deniedResponse = await requireOrg(c, params.data.orgId, "admin");
    if (deniedResponse) return deniedResponse;
    const parsedBody = await validateJsonV1(
      c,
      CreateRepositoryBodySchema,
      "invalid repository request",
    );
    if (!parsedBody.ok) return parsedBody.response;
    const resolvedRequest = resolveCreateRepositoryRequest(parsedBody.data);
    if (!resolvedRequest.ok) return errorResponse(c, 400, "BAD_REQUEST", resolvedRequest.error);
    const [org] = await db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, params.data.orgId))
      .limit(1);
    if (!org) return errorResponse(c, 404, "NOT_FOUND", "organization not found");
    try {
      const repo = await createRepository({
        orgId: params.data.orgId,
        orgSlug: org.slug,
        name: resolvedRequest.request.name,
        format: resolvedRequest.request.format,
        kind: resolvedRequest.request.kind,
        visibility: resolvedRequest.request.visibility,
        description: resolvedRequest.request.description,
      });
      audit({
        orgId: params.data.orgId,
        action: "repository.create",
        result: "success",
        resourceType: "repository",
        resourceId: repo.id,
        principal: c.get("principal"),
        detail: { name: repo.name, format: repo.format, kind: repo.kind },
      });
      return dataResponse(c, repositoryDto(repo), 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return errorResponse(
          c,
          409,
          "CONFLICT",
          `repository '${resolvedRequest.request.name}' already exists`,
        );
      }
      throw err;
    }
  },
);

apiV1Router.get("/repositories/:repoId", doc("Get a repository", "Repositories"), async (c) => {
  const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const access = await requireRepository(c, params.data.repoId, "read");
  if (!access.ok) return access.response;
  const countRows = await db
    .select({ value: count() })
    .from(packages)
    .where(eq(packages.repositoryId, access.repo.id));
  return dataResponse(c, {
    repository: repositoryDto(access.repo),
    packageCount: countRows[0]?.value ?? 0,
  });
});

apiV1Router.get("/repositories/:repoId/packages", doc("List packages", "Packages"), async (c) => {
  const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const pagination = validatePagination(c);
  if (!pagination.ok) return pagination.response;
  const repo = await repositoryById(params.data.repoId);
  if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
  const rows = await db
    .select({ id: packages.id, name: packages.name, latestVersion: packages.latestVersion })
    .from(packages)
    .where(eq(packages.repositoryId, repo.id))
    .orderBy(packages.name);
  const accessible = [];
  for (const pkg of rows) {
    const decision = await authorize(c.get("principal"), "read", {
      type: "package",
      orgId: repo.orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
      packageName: pkg.name,
      visibility: repo.visibility,
    });
    if (decision.allowed) accessible.push(pkg);
  }
  const page = accessible.slice(
    pagination.data.offset,
    pagination.data.offset + pagination.data.limit,
  );
  return listResponse(c, page, {
    limit: pagination.data.limit,
    offset: pagination.data.offset,
    total: accessible.length,
  });
});

apiV1Router.get(
  "/packages/:packageId/versions",
  doc("List package versions", "Packages"),
  async (c) => {
    const params = validateV1(c, PackageIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const pagination = validatePagination(c);
    if (!pagination.ok) return pagination.response;
    const row = await packageWithRepository(params.data.packageId);
    if (!row) return errorResponse(c, 404, "NOT_FOUND", "package not found");
    const response = await authorizePackage(c, row, "read");
    if (response) return response;
    const rows = await db
      .select({
        version: packageVersions.version,
        sizeBytes: packageVersions.sizeBytes,
        createdAt: packageVersions.createdAt,
      })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, row.pkg.id), isNull(packageVersions.deletedAt)))
      .orderBy(desc(packageVersions.createdAt));
    const page = rows.slice(pagination.data.offset, pagination.data.offset + pagination.data.limit);
    return c.json({
      data: { package: { id: row.pkg.id, name: row.pkg.name }, versions: page },
      pagination: {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total: rows.length,
      },
    });
  },
);

apiV1Router.get(
  "/repositories/:repoId/artifacts",
  doc("List artifacts", "Artifacts"),
  async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const pagination = validatePagination(c);
    if (!pagination.ok) return pagination.response;
    const repo = await repositoryById(params.data.repoId);
    if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
    const rows = await db
      .select({
        id: artifacts.id,
        digest: artifacts.digest,
        name: artifacts.name,
        version: artifacts.version,
        state: artifacts.state,
        policyDecision: artifacts.policyDecision,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(eq(artifacts.repositoryId, repo.id))
      .orderBy(desc(artifacts.createdAt));
    const accessible = [];
    for (const art of rows) {
      const decision = await authorize(c.get("principal"), "read", {
        type: "artifact",
        orgId: repo.orgId,
        repositoryId: repo.id,
        repositoryName: repo.name,
        artifactRef: art.digest,
        visibility: repo.visibility,
      });
      if (decision.allowed) accessible.push(art);
    }
    const page = accessible.slice(
      pagination.data.offset,
      pagination.data.offset + pagination.data.limit,
    );
    return listResponse(c, page, {
      limit: pagination.data.limit,
      offset: pagination.data.offset,
      total: accessible.length,
    });
  },
);

apiV1Router.get(
  "/artifacts/:artifactId/findings",
  doc("List artifact findings", "Artifacts"),
  async (c) => {
    const params = validateV1(c, ArtifactIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const row = await artifactWithRepository(params.data.artifactId);
    if (!row) return errorResponse(c, 404, "NOT_FOUND", "artifact not found");
    const response = await authorizeArtifact(c, row, "read");
    if (response) return response;
    const rows = await db
      .select({
        vulnId: findings.vulnId,
        type: findings.type,
        severity: findings.severity,
        packageName: findings.packageName,
        packageVersion: findings.packageVersion,
        fixedVersion: findings.fixedVersion,
        title: findings.title,
      })
      .from(findings)
      .where(eq(findings.artifactId, row.art.id));
    return dataResponse(c, rows);
  },
);

apiV1Router.post(
  "/orgs/:orgId/scan-policies",
  doc("Upsert a scan policy", "Policies"),
  async (c) => {
    const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const policyResponse = await authorizePolicy(c, {
      orgId: params.data.orgId,
      policy: "scan",
      action: "write",
    });
    if (policyResponse) return policyResponse;
    const parsedBody = await validateJsonV1(c, ScanPolicyBodySchema, "invalid scan policy request");
    if (!parsedBody.ok) return parsedBody.response;
    const repositoryPattern = parsedBody.data.repositoryPattern ?? "*";
    if (!isValidScanPolicyPattern(repositoryPattern)) {
      return errorResponse(
        c,
        400,
        "BAD_REQUEST",
        "repository pattern must use repository-name characters plus '*' wildcards, or '*' for all repositories",
      );
    }
    const [row] = await db
      .insert(scanPolicies)
      .values({
        orgId: params.data.orgId,
        repositoryPattern,
        mode: parsedBody.data.mode,
        blockOnSeverity: parsedBody.data.blockOnSeverity ?? null,
      })
      .onConflictDoUpdate({
        target: [scanPolicies.orgId, scanPolicies.repositoryPattern],
        set: {
          mode: parsedBody.data.mode,
          blockOnSeverity: parsedBody.data.blockOnSeverity ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    audit({
      orgId: params.data.orgId,
      action: "scan_policy.create",
      result: "success",
      resourceType: "scan_policy",
      resourceId: row?.id,
      principal: c.get("principal"),
      detail: { repositoryPattern, mode: parsedBody.data.mode },
    });
    return dataResponse(c, row, 201);
  },
);

apiV1Router.get("/orgs/:orgId/quota", doc("Get org quota", "Policies"), async (c) => {
  const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const policyResponse = await authorizePolicy(c, {
    orgId: params.data.orgId,
    policy: "quota",
    action: "read",
  });
  if (policyResponse) return policyResponse;
  const [q] = await db
    .select()
    .from(quotas)
    .where(and(eq(quotas.orgId, params.data.orgId), isNull(quotas.repositoryId)))
    .limit(1);
  return dataResponse(c, {
    maxStorageBytes: q?.maxStorageBytes ?? null,
    usedStorageBytes: q?.usedStorageBytes ?? 0,
    maxArtifacts: q?.maxArtifacts ?? null,
    usedArtifacts: q?.usedArtifacts ?? 0,
  });
});

apiV1Router.post("/orgs/:orgId/quota", doc("Set org quota", "Policies"), async (c) => {
  const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const policyResponse = await authorizePolicy(c, {
    orgId: params.data.orgId,
    policy: "quota",
    action: "write",
  });
  if (policyResponse) return policyResponse;
  const parsedBody = await validateJsonV1(c, QuotaBodySchema, "invalid quota request");
  if (!parsedBody.ok) return parsedBody.response;
  const usage = await calculateOrgQuotaUsage(params.data.orgId);
  await upsertOrgQuota(
    params.data.orgId,
    {
      maxStorageBytes: parsedBody.data.maxStorageBytes ?? null,
      maxArtifacts: parsedBody.data.maxArtifacts ?? null,
    },
    usage,
  );
  audit({
    orgId: params.data.orgId,
    action: "quota.set",
    result: "success",
    resourceType: "quota",
    principal: c.get("principal"),
  });
  return dataResponse(c, { ok: true });
});

apiV1Router.post(
  "/repositories/:repoId/retention/apply",
  doc("Apply retention", "Policies"),
  async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const repo = await repositoryById(params.data.repoId);
    if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
    const policyResponse = await authorizePolicy(c, {
      orgId: repo.orgId,
      repo,
      policy: "retention",
      action: "write",
    });
    if (policyResponse) return policyResponse;
    const parsedBody = await validateJsonV1(c, RetentionBodySchema, "invalid retention request");
    if (!parsedBody.ok) return parsedBody.response;
    const pruned = await applyRetention(repo.id, parsedBody.data.keepLastN);
    audit({
      orgId: repo.orgId,
      action: "retention.apply",
      result: "success",
      resourceType: "repository",
      resourceId: repo.id,
      principal: c.get("principal"),
      detail: { keepLastN: parsedBody.data.keepLastN, pruned },
    });
    return dataResponse(c, { pruned });
  },
);

apiV1Router.post(
  "/repositories/:repoId/upstreams",
  doc("Add a proxy upstream", "Repositories"),
  async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const access = await requireRepository(c, params.data.repoId, "admin");
    if (!access.ok) return access.response;
    const parentValidation = validateProxyUpstreamParent(access.repo);
    if (!parentValidation.ok)
      return errorResponse(c, parentValidation.status, "BAD_REQUEST", parentValidation.error);
    const parsedBody = await validateJsonV1(c, AddUpstreamBodySchema, "invalid upstream request");
    if (!parsedBody.ok) return parsedBody.response;
    const upstreamUrl = validateProxyUpstreamUrl(parsedBody.data.url);
    if (!upstreamUrl.ok)
      return errorResponse(c, upstreamUrl.status, "BAD_REQUEST", upstreamUrl.error);
    await addUpstream(access.repo.id, upstreamUrl.url, parsedBody.data.priority ?? 0);
    audit({
      orgId: access.repo.orgId,
      action: "repository.upstream.add",
      result: "success",
      resourceType: "repository",
      resourceId: access.repo.id,
      principal: c.get("principal"),
      detail: { url: parsedBody.data.url, priority: parsedBody.data.priority ?? 0 },
    });
    return dataResponse(c, { ok: true }, 201);
  },
);

apiV1Router.post(
  "/repositories/:repoId/members",
  doc("Add a virtual repository member", "Repositories"),
  async (c) => {
    const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const access = await requireRepository(c, params.data.repoId, "admin");
    if (!access.ok) return access.response;
    const parentValidation = validateVirtualMemberParent(access.repo);
    if (!parentValidation.ok)
      return errorResponse(c, parentValidation.status, "BAD_REQUEST", parentValidation.error);
    const parsedBody = await validateJsonV1(c, AddMemberBodySchema, "invalid member request");
    if (!parsedBody.ok) return parsedBody.response;
    const [memberCandidate] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, parsedBody.data.memberRepoId))
      .limit(1);
    const memberValidation = validateVirtualMemberCandidate(access.repo, memberCandidate);
    if (!memberValidation.ok)
      return errorResponse(c, memberValidation.status, "BAD_REQUEST", memberValidation.error);
    const memberResponse = await authorizeRepository(c, memberValidation.member, "read");
    if (memberResponse) return memberResponse;
    await addVirtualMember(
      access.repo.id,
      parsedBody.data.memberRepoId,
      parsedBody.data.position ?? 0,
    );
    audit({
      orgId: access.repo.orgId,
      action: "repository.member.add",
      result: "success",
      resourceType: "repository",
      resourceId: access.repo.id,
      principal: c.get("principal"),
      detail: { memberRepoId: memberValidation.member.id, position: parsedBody.data.position ?? 0 },
    });
    return dataResponse(c, { ok: true }, 201);
  },
);

apiV1Router.get("/orgs/:orgId/tokens", doc("List tokens", "Tokens"), async (c) => {
  const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const pagination = validatePagination(c);
  if (!pagination.ok) return pagination.response;
  const decision = await authorize(c.get("principal"), "read", {
    type: "token",
    orgId: params.data.orgId,
    tokenTarget: "org",
  });
  if (!decision.allowed) return authorizationDenied(c, decision);
  const rows = await db
    .select({
      token: apiTokens,
      ownerUsername: users.username,
    })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(eq(apiTokens.orgId, params.data.orgId))
    .orderBy(desc(apiTokens.createdAt));
  const page = rows.slice(pagination.data.offset, pagination.data.offset + pagination.data.limit);
  return listResponse(
    c,
    page.map((row) => tokenDto(row.token, row.ownerUsername)),
    { limit: pagination.data.limit, offset: pagination.data.offset, total: rows.length },
  );
});

apiV1Router.post(
  "/orgs/:orgId/tokens",
  describeRoute({
    tags: ["Tokens"],
    summary: "Create a grants-based token",
    requestBody: {
      content: {
        "application/json": {
          schema: resolver(CreateTokenV1BodySchema) as never,
        },
      },
    },
    responses: { 201: { description: "Created" }, 400: { description: "Bad request" } },
  }),
  async (c) => {
    const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const user = requireUserPrincipal(c);
    if (!user.ok) return errorResponse(c, 401, "UNAUTHENTICATED", "login required");
    const decision = await authorize(user.principal, "write", {
      type: "token",
      orgId: params.data.orgId,
      tokenTarget: "org",
    });
    if (!decision.allowed) return authorizationDenied(c, decision);
    const parsedBody = await validateJsonV1(c, CreateTokenV1BodySchema, "invalid token request");
    if (!parsedBody.ok) return parsedBody.response;
    const request = resolveCreateTokenRequest(parsedBody.data);
    const grant = await validateTokenGrant({
      userId: user.principal.userId,
      orgId: params.data.orgId,
      requestedRole: request.requestedRole,
      grants: request.grants,
    });
    if (!grant.ok) return errorResponse(c, 403, "FORBIDDEN", grant.error);
    const { token, secret } = await createApiToken({
      orgId: params.data.orgId,
      ownerUserId: user.principal.userId,
      name: request.name,
      type: request.type,
      grants: request.grants,
      role: request.requestedRole,
      expiresAt: request.expiresAt,
    });
    audit({
      orgId: params.data.orgId,
      action: "token.create",
      result: "success",
      resourceType: "token",
      resourceId: token.id,
      principal: user.principal,
      detail: { name: token.name, type: token.type },
    });
    return dataResponse(c, { token: tokenDto(token, user.principal.username), secret }, 201);
  },
);

apiV1Router.get("/tokens/:tokenId", doc("Get a token", "Tokens"), async (c) => {
  const params = validateV1(c, TokenIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const [row] = await db
    .select({ token: apiTokens, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(eq(apiTokens.id, params.data.tokenId))
    .limit(1);
  if (!row) return errorResponse(c, 404, "NOT_FOUND", "token not found");
  const response = await tokenResource(c, row.token, "read");
  if (response) return response;
  return dataResponse(c, tokenDto(row.token, row.ownerUsername));
});

apiV1Router.post("/tokens/:tokenId/rotate", doc("Rotate a token", "Tokens"), async (c) => {
  const params = validateV1(c, TokenIdParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const [token] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, params.data.tokenId))
    .limit(1);
  if (!token) return errorResponse(c, 404, "NOT_FOUND", "token not found");
  const response = await tokenResource(c, token, "write");
  if (response) return response;
  const rotated = await rotateToken(token.id, principalActor(c.get("principal")));
  if (!rotated) return errorResponse(c, 404, "NOT_FOUND", "token not found");
  audit({
    orgId: token.orgId,
    action: "token.rotate",
    result: "success",
    resourceType: "token",
    resourceId: token.id,
    principal: c.get("principal"),
  });
  return dataResponse(c, { token: tokenDto(rotated.token), secret: rotated.secret });
});

apiV1Router.delete("/orgs/:orgId/tokens/:tokenId", doc("Revoke a token", "Tokens"), async (c) => {
  const params = validateV1(c, OrgTokenParamsSchema, c.req.param(), "invalid path parameters");
  if (!params.ok) return params.response;
  const [token] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, params.data.tokenId))
    .limit(1);
  if (!token || token.orgId !== params.data.orgId) {
    return errorResponse(c, 404, "NOT_FOUND", "token not found");
  }
  const response = await tokenResource(c, token, "delete");
  if (response) return response;
  await revokeToken(token.id, principalActor(c.get("principal")), "revoked via api v1");
  audit({
    orgId: token.orgId,
    action: "token.revoke",
    result: "success",
    resourceType: "token",
    resourceId: token.id,
    principal: c.get("principal"),
  });
  return dataResponse(c, { ok: true });
});
