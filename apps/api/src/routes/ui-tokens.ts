import {
  authorize,
  createApiToken,
  getApiTokenById,
  listOrgTokens,
  listOrgTokensOwnedBy,
  revokeToken,
  validateTokenGrant,
} from "@hootifactory/auth";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { tokenDto } from "./ui-dto";
import { requireUserPrincipal } from "./ui-repository-access";
import { CreateTokenBodySchema } from "./ui-schemas";
import { resolveCreateTokenRequest } from "./ui-token-create";

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
    const rows = adminDecision.allowed
      ? await listOrgTokens(orgId)
      : await listOrgTokensOwnedBy(orgId, p.userId);
    return c.json({
      tokens: rows.map((row) => tokenDto(row.token, row.ownerUsername)),
    });
  });

  router.delete("/orgs/:orgId/tokens/:tokenId", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgToken);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId, tokenId } = parsedParams.data;
    const user = requireUserPrincipal(c);
    if (!user.ok) return user.response;
    const p = user.principal;
    const tok = await getApiTokenById(tokenId);
    if (!tok || tok.orgId !== orgId) return c.json({ error: "token not found" }, 404);
    const isOwner = tok.ownerUserId === p.userId;
    if (!isOwner) {
      const decision = await authorize(p, "admin", { type: "org", orgId });
      if (!decision.allowed) return c.json({ error: "forbidden" }, 403);
    }
    await revokeToken(tokenId, { userId: p.userId });
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
      grants: request.grants,
    });
    if (!grant.ok) return c.json({ error: grant.error }, 403);

    const { token, secret } = await createApiToken({
      orgId,
      ownerUserId: p.userId,
      name: request.name,
      type: request.type,
      grants: request.grants,
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
