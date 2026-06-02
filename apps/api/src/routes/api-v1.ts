import { authorize } from "@hootifactory/auth";
import {
  addUpstream,
  addVirtualMember,
  createRepository,
  isUniqueViolation,
} from "@hootifactory/core";
import {
  and,
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
  repositories,
} from "@hootifactory/db";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import type { AppEnv } from "../types";
import {
  ArtifactIdParamsSchema,
  artifactWithRepository,
  authorizeArtifact,
  authorizePackage,
  authorizeRepository,
  dataResponse,
  doc,
  errorResponse,
  listAccessibleRepositories,
  listResponse,
  OrgIdParamsSchema,
  PackageIdParamsSchema,
  packageWithRepository,
  RepoIdParamsSchema,
  repositoryById,
  requireOrg,
  requireRepository,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { registerApiV1PolicyRoutes } from "./api-v1-policy-routes";
import { registerApiV1TokenRoutes } from "./api-v1-token-routes";
import { audit } from "./http";
import { repositoryDto } from "./ui-dto";
import { listAccessibleOrgs } from "./ui-orgs";
import { resolveCreateRepositoryRequest } from "./ui-repository-create";
import {
  AddMemberBodySchema,
  AddUpstreamBodySchema,
  CreateRepositoryBodySchema,
} from "./ui-schemas";
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

registerApiV1PolicyRoutes(apiV1Router);

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

registerApiV1TokenRoutes(apiV1Router);
