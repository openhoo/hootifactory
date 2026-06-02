import { authorize, createApiToken, revokeToken, rotateToken } from "@hootifactory/auth";
import { apiTokens, db, desc, eq, users } from "@hootifactory/db";
import type { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { AppEnv } from "../types";
import {
  authorizationDenied,
  dataResponse,
  doc,
  errorResponse,
  listResponse,
  OrgIdParamsSchema,
  OrgTokenParamsSchema,
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
import { CreateTokenV1BodySchema } from "./ui-schemas";
import { resolveCreateTokenRequest } from "./ui-token-create";
import { validateTokenGrant } from "./ui-token-grants";

export function registerApiV1TokenRoutes(apiV1Router: Hono<AppEnv>) {
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
}
