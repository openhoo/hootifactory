import {
  ACTIONS,
  type Action,
  isRoleName as isSharedRoleName,
  ROLE_NAMES,
  type RoleName,
} from "@hootifactory/types";

export type { Action, RoleName } from "@hootifactory/types";

export const ROLES: readonly RoleName[] = ROLE_NAMES;

export const ROLE_ACTIONS: Record<RoleName, readonly Action[]> = {
  viewer: ["read"],
  developer: ["read", "write"],
  admin: ACTIONS,
  owner: ACTIONS,
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
  return isSharedRoleName(value);
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
