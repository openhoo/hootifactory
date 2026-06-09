import type { PermissionKey, Principal, TokenGrant } from "@hootifactory/types";
import { authorize, authorizePermission } from "./authorize";
import type { Action } from "./permissions";
import type { Decision } from "./principal";
import { validateTokenGrant } from "./token-grants";
import type { ApiTokenRow, ApiTokenWithOwner, TokenActor } from "./tokens";
import { listOrgTokens, listOrgTokensOwnedBy } from "./tokens";

type TokenManagementResult<T> = { ok: true; value: T } | { ok: false; decision: Decision };

function unauthenticated(reason = "login required"): Decision {
  return { allowed: false, code: "unauthenticated", reason };
}

export function principalActor(principal: Principal): TokenActor {
  return {
    userId: principal.kind === "user" ? principal.userId : null,
    tokenId: principal.kind === "token" ? principal.tokenId : null,
  };
}

function tokenTargetFor(principal: Principal, token: ApiTokenRow): "self" | "org" {
  if (principal.kind === "token" && principal.tokenId === token.id) return "self";
  if (principal.kind === "user" && token.ownerUserId === principal.userId) return "self";
  return "org";
}

function tokenPermissionForAction(action: Action): PermissionKey {
  if (action === "read") return "token.read";
  if (action === "write") return "token.rotate";
  if (action === "delete") return "token.revoke";
  return "token.create";
}

export function tokenResourceDecision(
  principal: Principal,
  token: ApiTokenRow,
  action: Action,
): Promise<Decision> {
  const tokenTarget = tokenTargetFor(principal, token);
  return authorizePermission(principal, tokenPermissionForAction(action), {
    type: "token",
    orgId: token.orgId,
    tokenId: token.id,
    tokenTarget,
  });
}

export function authorizeTokenCreation(principal: Principal, orgId: string): Promise<Decision> {
  if (principal.kind !== "user") return Promise.resolve(unauthenticated());
  return authorizePermission(principal, "token.create", {
    type: "token",
    orgId,
    tokenTarget: "org",
  });
}

export async function validateCreatedTokenGrant(input: {
  principal: Principal;
  orgId: string;
  grants: TokenGrant[];
}): Promise<TokenManagementResult<undefined>> {
  if (input.principal.kind !== "user") return { ok: false, decision: unauthenticated() };
  const grant = await validateTokenGrant({
    principal: input.principal,
    orgId: input.orgId,
    grants: input.grants,
  });
  if (grant.ok) return { ok: true, value: undefined };
  return {
    ok: false,
    decision: { allowed: false, code: "forbidden", reason: grant.error },
  };
}

export async function visibleTokensForPrincipal(
  principal: Principal,
  orgId: string,
): Promise<TokenManagementResult<ApiTokenWithOwner[]>> {
  const adminDecision = await authorizePermission(principal, "token.read", {
    type: "token",
    orgId,
    tokenTarget: "org",
  });
  if (adminDecision.allowed) return { ok: true, value: await listOrgTokens(orgId) };

  if (principal.kind === "user") {
    const readDecision = await authorize(principal, "read", { type: "org", orgId });
    if (!readDecision.allowed) return { ok: false, decision: readDecision };
    return { ok: true, value: await listOrgTokensOwnedBy(orgId, principal.userId) };
  }

  return { ok: false, decision: adminDecision };
}
