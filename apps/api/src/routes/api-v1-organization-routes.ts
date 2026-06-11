import {
  createOrganizationWithOwner,
  getOrganizationById,
  listAccessibleOrgs,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  V1CreateOrgRequestSchema,
  V1CreateRepositoryRequestSchema,
  V1MeResponseSchema,
  V1OrganizationListResponseSchema,
  V1OrganizationResponseSchema,
  V1RepositoryListResponseSchema,
  V1RepositoryResponseSchema,
} from "@hootifactory/contracts";
import { isUniqueViolation } from "@hootifactory/core";
import { createRepositoryForPrincipal } from "@hootifactory/registry-platform/repositories";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { repositoryDto } from "./api-v1-dto";
import {
  dataResponse,
  doc,
  errorResponse,
  listAccessibleRepositories,
  listResponse,
  OrgIdParamsSchema,
  PaginationQuerySchema,
  requireOrg,
  requireUserPrincipal,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { AUDIT_RESULT, audit } from "./http";

export function registerApiV1OrganizationRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.get(
    "/me",
    doc({
      operationId: "getCurrentPrincipal",
      summary: "Inspect the current principal",
      tag: "Identity",
      description: "Returns the authenticated user, API token, or registry bearer principal.",
      response: { description: "Authenticated principal.", schema: V1MeResponseSchema },
    }),
    (c) => {
      const principal = c.get("principal");
      if (principal.kind === "anonymous") {
        return errorResponse(c, 401, "UNAUTHENTICATED", "authentication required");
      }
      return dataResponse(c, { authenticated: true, principal });
    },
  );

  apiV1Router.get(
    "/orgs",
    doc({
      operationId: "listAccessibleOrganizations",
      summary: "List accessible organizations",
      tag: "Organizations",
      description: "Lists organizations visible to the current principal.",
      response: {
        description: "Organizations visible to the caller.",
        schema: V1OrganizationListResponseSchema,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      if (principal.kind === "user") {
        return dataResponse(c, await listAccessibleOrgs(principal.userId));
      }
      if (principal.kind === "token") {
        const org = await getOrganizationById(principal.orgId);
        if (!org) return dataResponse(c, []);
        const response = await requireOrg(c, org.id, "read");
        return response ? response : dataResponse(c, [org]);
      }
      return errorResponse(c, 401, "UNAUTHENTICATED", "authentication required");
    },
  );

  apiV1Router.post(
    "/orgs",
    doc({
      operationId: "createOrganization",
      summary: "Create an organization",
      tag: "Organizations",
      description: "Creates an organization owned by the calling user.",
      requestBody: {
        description: "Organization creation payload.",
        schema: V1CreateOrgRequestSchema,
      },
      response: {
        status: 201,
        description: "Organization created.",
        schema: V1OrganizationResponseSchema,
      },
      extraResponses: { 409: { description: "Organization slug already taken." } },
    }),
    async (c) => {
      if (!env.AUTH_ALLOW_ORG_CREATION) {
        return errorResponse(c, 403, "FORBIDDEN", "org creation is disabled");
      }
      const user = requireUserPrincipal(c);
      if (!user.ok) return user.response;
      const parsedBody = await validateJsonV1(c, V1CreateOrgRequestSchema, "invalid org request");
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.data;
      try {
        const org = await createOrganizationWithOwner({
          slug: body.slug,
          displayName: body.displayName,
          description: body.description,
          ownerUserId: user.principal.userId,
        });
        audit(c, {
          orgId: org.id,
          action: "org.create",
          result: AUDIT_RESULT.success,
          resourceType: "org",
          resourceId: org.id,
          principal: user.principal,
          detail: { slug: org.slug },
        });
        return dataResponse(c, org, 201);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return errorResponse(c, 409, "CONFLICT", `org slug '${body.slug}' already taken`);
        }
        throw err;
      }
    },
  );

  apiV1Router.get(
    "/orgs/:orgId",
    doc({
      operationId: "getOrganization",
      summary: "Get an organization",
      tag: "Organizations",
      description: "Gets organization metadata when the caller has read access.",
      pathParams: OrgIdParamsSchema,
      response: { description: "Organization metadata.", schema: V1OrganizationResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const response = await requireOrg(c, params.data.orgId, "read");
      if (response) return response;
      const org = await getOrganizationById(params.data.orgId);
      if (!org) return errorResponse(c, 404, "NOT_FOUND", "organization not found");
      return dataResponse(c, org);
    },
  );

  apiV1Router.get(
    "/orgs/:orgId/repositories",
    doc({
      operationId: "listOrganizationRepositories",
      summary: "List repositories",
      tag: "Repositories",
      description: "Lists repositories in an organization that the caller can read.",
      pathParams: OrgIdParamsSchema,
      query: PaginationQuerySchema,
      response: {
        description: "Repositories visible to the caller.",
        schema: V1RepositoryListResponseSchema,
      },
    }),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const pagination = validatePagination(c);
      if (!pagination.ok) return pagination.response;
      const { rows, total } = await listAccessibleRepositories(
        params.data.orgId,
        c,
        pagination.data,
      );
      return listResponse(c, rows.map(repositoryDto), {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total,
      });
    },
  );

  apiV1Router.post(
    "/orgs/:orgId/repositories",
    doc({
      operationId: "createRepository",
      summary: "Create a repository",
      tag: "Repositories",
      description: "Creates a hosted, proxy, or virtual repository in an organization.",
      pathParams: OrgIdParamsSchema,
      requestBody: {
        description: "Repository creation payload.",
        schema: V1CreateRepositoryRequestSchema,
      },
      response: {
        status: 201,
        description: "Repository created.",
        schema: V1RepositoryResponseSchema,
      },
      extraResponses: { 409: { description: "Repository name already exists." } },
    }),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const parsedBody = await validateJsonV1(
        c,
        V1CreateRepositoryRequestSchema,
        "invalid repository request",
      );
      if (!parsedBody.ok) return parsedBody.response;
      const created = await createRepositoryForPrincipal({
        principal: c.get("principal"),
        orgId: params.data.orgId,
        body: parsedBody.data,
      });
      if (!created.ok) {
        return errorResponse(c, created.status, created.code, created.error);
      }
      const { repo } = created;
      audit(c, {
        orgId: params.data.orgId,
        action: "repository.create",
        result: AUDIT_RESULT.success,
        resourceType: "repository",
        resourceId: repo.id,
        principal: c.get("principal"),
        detail: { name: repo.name, moduleId: repo.moduleId, kind: repo.kind },
      });
      return dataResponse(c, repositoryDto(repo), 201);
    },
  );
}
