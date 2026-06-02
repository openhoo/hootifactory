import type {
  FormatAdapter,
  HttpMethod,
  RepoContext,
  ResolvedRepo,
  RouteMatch,
} from "@hootifactory/core";
import { addSpanEvent } from "@hootifactory/observability";
import { buildRepoContext } from "./context";
import { authorizeRoute, type RouteAuthorization } from "./registry-auth";

export interface AuthAttributeSpan {
  setAttributes(attributes: Record<string, string>): void;
}

export interface VirtualMemberAuthorization extends RouteAuthorization {
  memberCtx: RepoContext;
}

export function virtualMemberSkipReason(authorization: VirtualMemberAuthorization): string {
  return authorization.decision.reason ?? authorization.decision.code ?? "denied";
}

export async function authorizeVirtualMember(
  adapter: FormatAdapter,
  method: HttpMethod,
  match: RouteMatch,
  member: ResolvedRepo,
  parentCtx: RepoContext,
  span: AuthAttributeSpan,
): Promise<VirtualMemberAuthorization> {
  const memberCtx = buildRepoContext(member, parentCtx.principal);
  const authorization = await authorizeRoute(adapter, method, match, memberCtx);
  span.setAttributes({
    "auth.action": authorization.permission.action,
    "auth.decision": authorization.decision.allowed ? "allowed" : "denied",
  });
  if (!authorization.decision.allowed) {
    addSpanEvent("registry.virtual.member_skipped", {
      "auth.reason": virtualMemberSkipReason({ ...authorization, memberCtx }),
    });
  }
  return { ...authorization, memberCtx };
}
