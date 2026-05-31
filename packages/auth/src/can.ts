import type { Action, RoleName } from "./permissions";
import { roleAllows } from "./permissions";
import type { Decision, Principal, ResourceRef } from "./principal";
import { scopeGrants } from "./scope";

export interface CanInput {
  principal: Principal;
  action: Action;
  resource: ResourceRef;
  /** Principal's resolved role in resource.org (for users and scope-less tokens). */
  effectiveRole?: RoleName | null;
}

/**
 * The single authoritative authorization decision. Pure and synchronous so it
 * is exhaustively unit-testable. Role resolution + DB lookups happen in
 * authorize() which then calls this.
 *
 * Contract: denials for unauthenticated principals map to HTTP 401 (re-auth);
 * all other denials map to 403.
 */
export function can({ principal, action, resource, effectiveRole }: CanInput): Decision {
  // ── anonymous ────────────────────────────────────────────────────────────
  if (principal.kind === "anonymous") {
    if (action === "read" && resource.type === "repository" && resource.visibility === "public") {
      return { allowed: true };
    }
    return { allowed: false, code: "unauthenticated", reason: "authentication required" };
  }

  // ── token ────────────────────────────────────────────────────────────────
  if (principal.kind === "token") {
    // Org boundary — enforced on every call.
    if (resource.orgId && principal.orgId !== resource.orgId) {
      return { allowed: false, code: "cross_org", reason: "token not valid for this organization" };
    }
    // Explicit scopes are a ceiling: when present, only scope grants apply.
    if (principal.scopes.length > 0 && resource.repositoryName) {
      if (scopeGrants(principal.scopes, resource.repositoryName, action)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        code: "insufficient_scope",
        reason: `token scope does not grant '${action}' on ${resource.repositoryName}`,
      };
    }
    // Scope-less token inherits a role (robot role, or owner's membership role).
    const role = principal.role ?? effectiveRole ?? null;
    if (role && roleAllows(role, action)) return { allowed: true };
    return { allowed: false, code: "insufficient_role", reason: `role does not grant '${action}'` };
  }

  // ── user (session) ─────────────────────────────────────────────────────────
  if (!effectiveRole) {
    return { allowed: false, code: "not_member", reason: "no role in this organization" };
  }
  if (roleAllows(effectiveRole, action)) return { allowed: true };
  return {
    allowed: false,
    code: "insufficient_role",
    reason: `role '${effectiveRole}' does not grant '${action}'`,
  };
}
