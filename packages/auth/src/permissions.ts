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

export function isRoleName(value: unknown): value is RoleName {
  return typeof value === "string" && Object.hasOwn(ROLE_RANK, value);
}

export function roleOutranks(candidate: RoleName, current: RoleName): boolean {
  return ROLE_RANK[candidate] > ROLE_RANK[current];
}

/** Pick the higher-privilege of two roles. */
export function maxRole(a: RoleName, b: RoleName): RoleName {
  return roleOutranks(b, a) ? b : a;
}

/** Pick the lower-privilege of two roles. */
export function minRole(a: RoleName, b: RoleName): RoleName {
  return roleOutranks(a, b) ? b : a;
}
