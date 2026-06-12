import { PERMISSION_KEYS, type PermissionKey } from "@hootifactory/types";
import { useMemo } from "react";
import { useOrg } from "@/features/orgs/context";
import type { User } from "@/lib/api";

/** Display label for a user: their display name, falling back to the username. */
export function displayUser(user: User) {
  return user.displayName || user.username;
}

/**
 * Permission helpers derived from the selected org. `has` treats `system.admin`
 * as a wildcard; `assignablePermissions` is the set a manager may grant to a
 * group (everything they themselves hold, minus the un-grantable `system.admin`).
 */
export function usePermissions() {
  const { selected } = useOrg();
  const set = useMemo(
    () => new Set<PermissionKey>(selected?.permissions ?? []),
    [selected?.permissions],
  );
  const has = (permission: PermissionKey) => set.has("system.admin") || set.has(permission);
  const assignablePermissions = useMemo(
    () =>
      PERMISSION_KEYS.filter((permission) => permission !== "system.admin").filter((permission) =>
        set.has(permission),
      ),
    [set],
  );
  return { has, assignablePermissions };
}
