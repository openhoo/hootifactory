import { authorize, createApiToken, revokeToken } from "@hootifactory/auth";
import { and, apiTokens, db, desc, eq, users } from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { tokenDto } from "./ui-dto";
import { requireUserPrincipal } from "./ui-repository-access";
import { CreateTokenBodySchema } from "./ui-schemas";
import { resolveCreateTokenRequest } from "./ui-token-create";
import { validateTokenGrant } from "./ui-token-grants";

export function registerTokenRoutes(router: Hono<AppEnv>): void {
  router.get("/orgs/:orgId/tokens", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const user = requireUserPrincipal(c);
    if (!user.ok) return user.response;
    const p = user.principal;
    const adminDecision = await authorize(p, "admin", { type: "org", orgId });
    const readDecision = adminDecision.allowed
      ? adminDecision
      : await authorize(p, "read", { type: "org", orgId });
    if (!readDecision.allowed) return c.json({ error: readDecision.reason }, 403);
    const where = adminDecision.allowed
      ? eq(apiTokens.orgId, orgId)
      : and(eq(apiTokens.orgId, orgId), eq(apiTokens.ownerUserId, p.userId));
    const rows = await db
      .select({
        id: apiTokens.id,
        ownerUserId: apiTokens.ownerUserId,
        ownerUsername: users.username,
        name: apiTokens.name,
        prefix: apiTokens.tokenPrefix,
        type: apiTokens.type,
        scopes: apiTokens.scopes,
        role: apiTokens.role,
        expiresAt: apiTokens.expiresAt,
        revokedAt: apiTokens.revokedAt,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
      .where(where)
      .orderBy(desc(apiTokens.createdAt));
    return c.json({ tokens: rows });
  });

  router.delete("/orgs/:orgId/tokens/:tokenId", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgToken);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId, tokenId } = parsedParams.data;
    const user = requireUserPrincipal(c);
    if (!user.ok) return user.response;
    const p = user.principal;
    const [tok] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1);
    if (!tok || tok.orgId !== orgId) return c.json({ error: "token not found" }, 404);
    const isOwner = tok.ownerUserId === p.userId;
    if (!isOwner) {
      const decision = await authorize(p, "admin", { type: "org", orgId });
      if (!decision.allowed) return c.json({ error: "forbidden" }, 403);
    }
    await revokeToken(tokenId);
    audit({
      orgId,
      action: "token.revoke",
      result: "success",
      resourceType: "token",
      resourceId: tokenId,
      principal: p,
    });
    return c.json({ ok: true });
  });

  router.post("/orgs/:orgId/tokens", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const user = requireUserPrincipal(c);
    if (!user.ok) return user.response;
    const p = user.principal;
    const decision = await authorize(p, "read", { type: "org", orgId });
    if (!decision.allowed) return c.json({ error: decision.reason }, 403);

    const parsedBody = await validateJsonBody(c, CreateTokenBodySchema, "invalid token request");
    if (!parsedBody.ok) return parsedBody.response;
    const request = resolveCreateTokenRequest(parsedBody.data);

    const grant = await validateTokenGrant({
      userId: p.userId,
      orgId,
      requestedRole: request.requestedRole,
      scopes: request.scopes,
    });
    if (!grant.ok) return c.json({ error: grant.error }, 403);

    const { token, secret } = await createApiToken({
      orgId,
      ownerUserId: p.userId,
      name: request.name,
      type: request.type,
      scopes: request.scopes,
      role: request.requestedRole,
      expiresAt: request.expiresAt,
    });
    audit({
      orgId,
      action: "token.create",
      result: "success",
      resourceType: "token",
      resourceId: token.id,
      principal: p,
      detail: { name: token.name, type: token.type },
    });
    return c.json({ token: tokenDto(token, p.username), secret }, 201);
  });
}
