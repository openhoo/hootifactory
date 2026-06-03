import { getOrganizationById, listAccessibleOrgs } from "@hootifactory/auth";
import {
  V1CreateRepositoryRequestSchema,
  V1MeResponseSchema,
  V1OrganizationListResponseSchema,
  V1OrganizationResponseSchema,
  V1RepositoryListResponseSchema,
  V1RepositoryResponseSchema,
} from "@hootifactory/contracts";
import { isUniqueViolation } from "@hootifactory/core";
import { createRepository } from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  dataResponse,
  doc,
  errorResponse,
  listAccessibleRepositories,
  listResponse,
  OrgIdParamsSchema,
  PaginationQuerySchema,
  requireOrg,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { audit } from "./http";
import { repositoryDto } from "./ui-dto";
import { resolveCreateRepositoryRequest } from "./ui-repository-create";

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
      const rows = await listAccessibleRepositories(params.data.orgId, c);
      const page = rows.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(c, page.map(repositoryDto), {
        limit: pagination.data.limit,
        offset: pagination.data.offset,
        total: rows.length,
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
      const deniedResponse = await requireOrg(c, params.data.orgId, "admin");
      if (deniedResponse) return deniedResponse;
      const parsedBody = await validateJsonV1(
        c,
        V1CreateRepositoryRequestSchema,
        "invalid repository request",
      );
      if (!parsedBody.ok) return parsedBody.response;
      const resolvedRequest = resolveCreateRepositoryRequest(parsedBody.data);
      if (!resolvedRequest.ok) {
        return errorResponse(c, 400, "BAD_REQUEST", resolvedRequest.error);
      }
      const org = await getOrganizationById(params.data.orgId);
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
}
