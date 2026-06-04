import {
  authorizeTokenCreation,
  createApiToken,
  getApiTokenById,
  principalActor,
  revokeToken,
  tokenResourceDecision,
  validateCreatedTokenGrant,
  visibleTokensForPrincipal,
} from "@hootifactory/auth";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit, denied } from "./http";
import { tokenDto } from "./ui-dto";
import { requireUserPrincipal } from "./ui-repository-access";
import { CreateTokenBodySchema } from "./ui-schemas";
import { resolveCreateTokenRequest } from "./ui-token-create";

export function registerTokenRoutes(router: Hono<AppEnv>): void {
  router.get("/orgs/:orgId/tokens", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const visible = await visibleTokensForPrincipal(c.get("principal"), orgId);
    if (!visible.ok) return denied(c, visible.decision);
    return c.json({
      tokens: visible.value.map((row) => tokenDto(row.token, row.ownerUsername)),
    });
  });

  router.delete("/orgs/:orgId/tokens/:tokenId", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgToken);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId, tokenId } = parsedParams.data;
    const tok = await getApiTokenById(tokenId);
    if (!tok || tok.orgId !== orgId) return c.json({ error: "token not found" }, 404);
    const decision = await tokenResourceDecision(c.get("principal"), tok, "delete");
    if (!decision.allowed) return denied(c, decision);
    await revokeToken(tokenId, principalActor(c.get("principal")), "revoked via ui");
    audit({
      orgId,
      action: "token.revoke",
      result: "success",
      resourceType: "token",
      resourceId: tokenId,
      principal: c.get("principal"),
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
    const decision = await authorizeTokenCreation(p, orgId);
    if (!decision.allowed) return denied(c, decision);

    const parsedBody = await validateJsonBody(c, CreateTokenBodySchema, "invalid token request");
    if (!parsedBody.ok) return parsedBody.response;
    const request = resolveCreateTokenRequest(parsedBody.data);

    const grant = await validateCreatedTokenGrant({
      principal: p,
      orgId,
      requestedRole: request.requestedRole,
      grants: request.grants,
    });
    if (!grant.ok) return denied(c, grant.decision);

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
