import {
  authorize,
  createApiToken,
  getApiTokenById,
  getApiTokenWithOwner,
  listOrgTokens,
  revokeToken,
  rotateToken,
  validateTokenGrant,
} from "@hootifactory/auth";
import {
  V1CreateTokenRequestSchema,
  V1OkResponseSchema,
  V1TokenListResponseSchema,
  V1TokenResponseSchema,
  V1TokenSecretResponseSchema,
} from "@hootifactory/contracts";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  authorizationDenied,
  dataResponse,
  doc,
  errorResponse,
  listResponse,
  OrgIdParamsSchema,
  OrgTokenParamsSchema,
  PaginationQuerySchema,
  principalActor,
  TokenIdParamsSchema,
  tokenResource,
  validateJsonV1,
  validatePagination,
  validateV1,
} from "./api-v1-helpers";
import { audit } from "./http";
import { tokenDto } from "./ui-dto";
import { requireUserPrincipal } from "./ui-repository-access";
import { resolveCreateTokenRequest } from "./ui-token-create";

export function registerApiV1TokenRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.get(
    "/orgs/:orgId/tokens",
    doc({
      operationId: "listOrganizationTokens",
      summary: "List tokens",
      tag: "Tokens",
      description: "Lists API tokens in an organization visible to the caller.",
      pathParams: OrgIdParamsSchema,
      query: PaginationQuerySchema,
      response: { description: "Organization API tokens.", schema: V1TokenListResponseSchema },
    }),
    async (c) => {
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
      const rows = await listOrgTokens(params.data.orgId);
      const page = rows.slice(
        pagination.data.offset,
        pagination.data.offset + pagination.data.limit,
      );
      return listResponse(
        c,
        page.map((row) => tokenDto(row.token, row.ownerUsername)),
        { limit: pagination.data.limit, offset: pagination.data.offset, total: rows.length },
      );
    },
  );

  apiV1Router.post(
    "/orgs/:orgId/tokens",
    doc({
      operationId: "createOrganizationToken",
      summary: "Create a grants-based token",
      tag: "Tokens",
      description: "Creates an API token from fine-grained grants. The secret is returned once.",
      pathParams: OrgIdParamsSchema,
      requestBody: {
        description: "Token creation payload.",
        schema: V1CreateTokenRequestSchema,
      },
      response: {
        status: 201,
        description: "Token created with one-time secret.",
        schema: V1TokenSecretResponseSchema,
      },
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
      const parsedBody = await validateJsonV1(
        c,
        V1CreateTokenRequestSchema,
        "invalid token request",
      );
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

  apiV1Router.get(
    "/tokens/:tokenId",
    doc({
      operationId: "getToken",
      summary: "Get a token",
      tag: "Tokens",
      description: "Gets API token metadata. Token secrets are not returned by this endpoint.",
      pathParams: TokenIdParamsSchema,
      response: { description: "API token metadata.", schema: V1TokenResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, TokenIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const row = await getApiTokenWithOwner(params.data.tokenId);
      if (!row) return errorResponse(c, 404, "NOT_FOUND", "token not found");
      const response = await tokenResource(c, row.token, "read");
      if (response) return response;
      return dataResponse(c, tokenDto(row.token, row.ownerUsername));
    },
  );

  apiV1Router.post(
    "/tokens/:tokenId/rotate",
    doc({
      operationId: "rotateToken",
      summary: "Rotate a token",
      tag: "Tokens",
      description: "Rotates an API token and returns the replacement secret once.",
      pathParams: TokenIdParamsSchema,
      response: {
        description: "Rotated token with one-time secret.",
        schema: V1TokenSecretResponseSchema,
      },
    }),
    async (c) => {
      const params = validateV1(c, TokenIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const token = await getApiTokenById(params.data.tokenId);
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
    },
  );

  apiV1Router.delete(
    "/orgs/:orgId/tokens/:tokenId",
    doc({
      operationId: "revokeOrganizationToken",
      summary: "Revoke a token",
      tag: "Tokens",
      description: "Revokes an API token in an organization.",
      pathParams: OrgTokenParamsSchema,
      response: { description: "Token revoked.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, OrgTokenParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const token = await getApiTokenById(params.data.tokenId);
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
    },
  );
}
