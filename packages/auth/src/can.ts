import type { PermissionGrantRow } from "./permission-grants";
import { permissionGrantsAllow } from "./permission-grants";
import type { Action, PermissionKey } from "./permissions";
import { permissionForAction } from "./permissions";
import type { Decision, Principal, ResourceRef } from "./principal";

export interface CanInput {
  principal: Principal;
  action?: Action;
  permission?: PermissionKey;
  resource: ResourceRef;
  grants?: PermissionGrantRow[];
}

function requiredPermission(input: CanInput): PermissionKey {
  if (input.permission) return input.permission;
  if (!input.action) throw new Error("action or permission is required");
  return permissionForAction(input.action, input.resource);
}

function denyPermission(permission: PermissionKey): Decision {
  return {
    allowed: false,
    code: "insufficient_scope",
    reason: `permission '${permission}' is required`,
  };
}

const ANONYMOUS_PUBLIC_READ_TYPES = new Set(["repository", "package", "artifact"]);
const PUBLIC_READ_PERMISSIONS = new Set<PermissionKey>([
  "repository.read",
  "package.read",
  "artifact.read",
]);

/**
 * Pure authorization decision. DB-backed subject/group/token grant resolution
 * happens in authorize(), which then calls this.
 */
export function can(input: CanInput): Decision {
  const permission = requiredPermission(input);

  if (input.principal.kind === "anonymous") {
    if (
      PUBLIC_READ_PERMISSIONS.has(permission) &&
      input.resource.visibility === "public" &&
      ANONYMOUS_PUBLIC_READ_TYPES.has(input.resource.type)
    ) {
      return { allowed: true };
    }
    return { allowed: false, code: "unauthenticated", reason: "authentication required" };
  }

  if (input.principal.kind === "registryToken") {
    if (!input.action) return denyPermission(permission);
    const name = input.resource.repositoryName;
    const granted =
      !!name &&
      input.principal.access.some(
        (a) =>
          a.type === "repository" &&
          a.name === name &&
          (a.actions.includes(input.action!) || a.actions.includes("*")),
      );
    return granted
      ? { allowed: true }
      : {
          allowed: false,
          code: "insufficient_scope",
          reason: `token does not grant '${input.action}' on ${name ?? "?"}`,
        };
  }

  if (
    input.principal.kind === "token" &&
    input.resource.orgId &&
    input.principal.orgId !== input.resource.orgId
  ) {
    return { allowed: false, code: "cross_org", reason: "token not valid for this organization" };
  }

  if (permissionGrantsAllow(input.grants ?? [], permission, input.resource)) {
    return { allowed: true };
  }

  return denyPermission(permission);
}
