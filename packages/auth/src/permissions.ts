import {
  ACTIONS,
  isPermissionKey as isSharedPermissionKey,
  PERMISSION_KEYS,
  type PermissionKey,
  type ResourceRef,
  type ResourceType,
} from "@hootifactory/types";

export type { Action, PermissionKey } from "@hootifactory/types";

export const PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS;

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  "system.admin": "Unrestricted global administration.",
  "org.read": "Read organization metadata.",
  "org.update": "Update organization metadata.",
  "org.delete": "Delete organizations.",
  "org.member.read": "List organization members.",
  "org.member.manage": "Add, update, and remove organization members.",
  "user.read": "Read user profiles.",
  "user.create": "Create users.",
  "user.update": "Update user profiles.",
  "user.deactivate": "Deactivate or reactivate users.",
  "user.reset_password": "Start admin password setup or reset flows.",
  "group.read": "Read groups.",
  "group.create": "Create groups.",
  "group.update": "Update groups.",
  "group.delete": "Delete groups.",
  "group.member.manage": "Add and remove group members.",
  "group.permission.manage": "Update group permissions.",
  "permission.read": "Inspect effective permissions.",
  "permission.grant": "Grant or revoke permissions.",
  "repository.read": "Read repository metadata and contents.",
  "repository.create": "Create repositories.",
  "repository.update": "Update repository metadata and configuration.",
  "repository.write": "Publish repository content.",
  "repository.delete": "Delete repository content or repositories.",
  "repository.permission.manage": "Update repository-scoped access.",
  "package.read": "Read packages.",
  "package.write": "Publish or update packages.",
  "package.delete": "Delete packages.",
  "artifact.read": "Read artifacts.",
  "artifact.write": "Publish or update artifacts.",
  "artifact.delete": "Delete artifacts.",
  "policy.read": "Read governance policies and scan findings.",
  "policy.write": "Create or update governance policies.",
  "policy.delete": "Delete governance policies.",
  "token.read": "Read token metadata.",
  "token.create": "Create tokens.",
  "token.rotate": "Rotate tokens.",
  "token.revoke": "Revoke tokens.",
};

export function isPermissionKey(value: unknown): value is PermissionKey {
  return isSharedPermissionKey(value);
}

export function isGenericAction(value: unknown): value is (typeof ACTIONS)[number] {
  return typeof value === "string" && ACTIONS.includes(value as (typeof ACTIONS)[number]);
}

function resourcePermissionPrefix(type: ResourceType): string {
  if (type === "system") return "system";
  if (type === "package") return "package";
  if (type === "artifact") return "artifact";
  if (type === "policy") return "policy";
  if (type === "token") return "token";
  if (type === "repository") return "repository";
  return "org";
}

export function permissionForAction(action: (typeof ACTIONS)[number], resource: ResourceRef) {
  if (resource.type === "system") return "system.admin" satisfies PermissionKey;
  if (resource.type === "token") {
    if (action === "read") return "token.read" satisfies PermissionKey;
    if (action === "write") return "token.rotate" satisfies PermissionKey;
    if (action === "delete") return "token.revoke" satisfies PermissionKey;
    return "token.create" satisfies PermissionKey;
  }
  if (resource.type === "org") {
    if (action === "read") return "org.read" satisfies PermissionKey;
    if (action === "delete") return "org.delete" satisfies PermissionKey;
    return "org.update" satisfies PermissionKey;
  }
  if (resource.type === "repository") {
    if (action === "read") return "repository.read" satisfies PermissionKey;
    if (action === "write") return "repository.write" satisfies PermissionKey;
    if (action === "delete") return "repository.delete" satisfies PermissionKey;
    return "repository.permission.manage" satisfies PermissionKey;
  }
  if (resource.type === "policy") {
    if (action === "read") return "policy.read" satisfies PermissionKey;
    if (action === "delete") return "policy.delete" satisfies PermissionKey;
    return "policy.write" satisfies PermissionKey;
  }
  const prefix = resourcePermissionPrefix(resource.type);
  const suffix = action === "admin" ? "write" : action;
  return `${prefix}.${suffix}` as PermissionKey;
}

const DIRECT_PERMISSION_IMPLICATIONS: Partial<Record<PermissionKey, readonly PermissionKey[]>> = {
  "org.member.manage": ["org.member.read"],
  "group.create": ["group.read"],
  "group.update": ["group.read"],
  "group.delete": ["group.read"],
  "group.member.manage": ["group.read"],
  "permission.grant": ["permission.read"],
  "user.create": ["user.read"],
  "user.update": ["user.read"],
  "user.deactivate": ["user.read"],
  "user.reset_password": ["user.read"],
  "repository.create": ["repository.read"],
  "repository.update": ["repository.read"],
  "repository.write": ["repository.read", "package.write", "artifact.write"],
  "repository.delete": ["repository.read", "package.delete", "artifact.delete"],
  "repository.permission.manage": ["repository.read"],
  "repository.read": ["package.read", "artifact.read"],
  "package.write": ["package.read"],
  "package.delete": ["package.read"],
  "artifact.write": ["artifact.read"],
  "artifact.delete": ["artifact.read"],
  "policy.write": ["policy.read"],
  "policy.delete": ["policy.read"],
  "token.rotate": ["token.read"],
  "token.revoke": ["token.read"],
};

export function permissionImplies(
  granted: PermissionKey,
  required: PermissionKey,
  seen = new Set<PermissionKey>(),
): boolean {
  if (granted === "system.admin") return true;
  if (granted === required) return true;
  if (seen.has(granted)) return false;
  seen.add(granted);
  for (const implied of DIRECT_PERMISSION_IMPLICATIONS[granted] ?? []) {
    if (permissionImplies(implied, required, seen)) return true;
  }
  return false;
}
