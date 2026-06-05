import { env } from "@hootifactory/config";
import { mapWithBoundedConcurrency } from "@hootifactory/core";
import { addSpanEvent, withSpan } from "@hootifactory/observability";
import type {
  HttpMethod,
  RegistryPlugin,
  RegistryRequestContext,
  ResolvedRepo,
  RouteMatch,
} from "@hootifactory/registry";
import {
  buildRegistryRequestContext,
  repoSpanAttributes,
} from "@hootifactory/registry-application/runtime";
import { authorizeRoute, type RouteAuthorization } from "./registry-auth";

export interface AuthAttributeSpan {
  setAttributes(attributes: Record<string, string>): void;
}

export interface VirtualMemberAuthorization extends RouteAuthorization {
  memberCtx: RegistryRequestContext;
}

export interface AuthorizedVirtualMember {
  member: ResolvedRepo;
  authorization: VirtualMemberAuthorization;
}

export function withVirtualMemberSpans<T>(
  members: ResolvedRepo[],
  spanName: string,
  handler: (member: ResolvedRepo, span: AuthAttributeSpan) => Promise<T>,
): Promise<T[]> {
  return mapWithBoundedConcurrency(members, env.REGISTRY_VIRTUAL_MEMBER_CONCURRENCY, (member) =>
    withSpan(spanName, repoSpanAttributes(member), (span) => handler(member, span)),
  );
}

export function virtualMemberSkipReason(authorization: VirtualMemberAuthorization): string {
  return authorization.decision.reason ?? authorization.decision.code ?? "denied";
}

export async function authorizeVirtualMember(
  adapter: RegistryPlugin,
  method: HttpMethod,
  match: RouteMatch,
  member: ResolvedRepo,
  parentCtx: RegistryRequestContext,
  span: AuthAttributeSpan,
): Promise<VirtualMemberAuthorization> {
  const memberCtx = buildRegistryRequestContext(member, parentCtx.principal);
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

export function authorizeVirtualMembers(
  adapter: RegistryPlugin,
  method: HttpMethod,
  match: RouteMatch,
  members: ResolvedRepo[],
  parentCtx: RegistryRequestContext,
  spanName: string,
): Promise<AuthorizedVirtualMember[]> {
  return withVirtualMemberSpans(members, spanName, async (member, span) => ({
    member,
    authorization: await authorizeVirtualMember(adapter, method, match, member, parentCtx, span),
  }));
}

export function mapVirtualMemberAuthorizations<T>(
  authorizations: AuthorizedVirtualMember[],
  handler: (authorization: AuthorizedVirtualMember) => Promise<T>,
): Promise<T[]> {
  return mapWithBoundedConcurrency(
    authorizations,
    env.REGISTRY_VIRTUAL_MEMBER_CONCURRENCY,
    (authorization) => handler(authorization),
  );
}
