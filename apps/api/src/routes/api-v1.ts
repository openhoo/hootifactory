import { createRepository, isUniqueViolation } from "@hootifactory/core";
import { db, eq, organizations } from "@hootifactory/db";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import type { AppEnv } from "../types";
import { registerApiV1ContentRoutes } from "./api-v1-content-routes";
import {
  dataResponse,
  doc,
  errorResponse,
  listAccessibleRepositories,
  listResponse,
  OrgIdParamsSchema,
  requireOrg,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { registerApiV1PolicyRoutes } from "./api-v1-policy-routes";
import { registerApiV1RepositoryConfigRoutes } from "./api-v1-repository-config-routes";
import { registerApiV1TokenRoutes } from "./api-v1-token-routes";
import { audit } from "./http";
import { repositoryDto } from "./ui-dto";
import { listAccessibleOrgs } from "./ui-orgs";
import { resolveCreateRepositoryRequest } from "./ui-repository-create";
import { CreateRepositoryBodySchema } from "./ui-schemas";

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

registerApiV1ContentRoutes(apiV1Router);

registerApiV1PolicyRoutes(apiV1Router);

registerApiV1RepositoryConfigRoutes(apiV1Router);

registerApiV1TokenRoutes(apiV1Router);
