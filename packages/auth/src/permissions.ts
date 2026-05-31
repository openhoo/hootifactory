export type Action = "read" | "write" | "delete" | "admin";

/** Fixed RBAC role matrix. Most-specific binding wins (resolved in authorize.ts). */
export type RoleName = "viewer" | "developer" | "admin" | "owner";

export const ROLES: readonly RoleName[] = ["viewer", "developer", "admin", "owner"];

export const ROLE_ACTIONS: Record<RoleName, readonly Action[]> = {
  viewer: ["read"],
  developer: ["read", "write"],
  admin: ["read", "write", "delete", "admin"],
  owner: ["read", "write", "delete", "admin"],
};

export const ROLE_RANK: Record<RoleName, number> = {
  viewer: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};

export function roleAllows(role: RoleName, action: Action): boolean {
  return ROLE_ACTIONS[role].includes(action);
}

/** Pick the higher-privilege of two roles. */
export function maxRole(a: RoleName, b: RoleName): RoleName {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}
