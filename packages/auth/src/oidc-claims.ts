import type { OidcGroupGrant, OidcGroupMappings } from "./oidc-types";
import { ROLE_RANK, type RoleName } from "./permissions";

// ── legacy single-org mapping ────────────────────────────────────────────────
// `mapGroupsToRole` / `groupRoleMap` (OidcProviderConfig) is the legacy single-org
// group->role mapping, retained for compatibility. New code should prefer the
// multi-org path below; the active OIDC callback flow uses mapGroupsToOrgRoles.

/**
 * Map IdP group claims to an org role using a provider's group->role map.
 * The highest-privilege matching role wins. Returns null if no group maps.
 */
export function mapGroupsToRole(
  groups: string[],
  groupRoleMap: Record<string, string>,
): RoleName | null {
  let best: RoleName | null = null;
  for (const g of groups) {
    const mapped = groupRoleMap[g] as RoleName | undefined;
    if (mapped && ROLE_RANK[mapped] && (!best || ROLE_RANK[mapped] > ROLE_RANK[best])) {
      best = mapped;
    }
  }
  return best;
}

// ── multi-org mapping (active) ───────────────────────────────────────────────
// `mapGroupsToOrgRoles` / `groupMappings` is the active multi-org mapping used by
// resolveOidcCallbackClaims (oidc-client.ts).

export function mapGroupsToOrgRoles(
  groups: string[],
  groupMappings: OidcGroupMappings,
): OidcGroupGrant[] {
  const byOrg = new Map<string, OidcGroupGrant>();
  for (const group of groups) {
    const grants = Object.hasOwn(groupMappings, group) ? groupMappings[group] : undefined;
    for (const grant of grants ?? []) {
      const existing = byOrg.get(grant.org);
      if (!existing || ROLE_RANK[grant.role] > ROLE_RANK[existing.role]) {
        byOrg.set(grant.org, { org: grant.org, role: grant.role, groups: [group] });
      } else if (existing.role === grant.role && !existing.groups.includes(group)) {
        existing.groups.push(group);
      }
    }
  }
  return [...byOrg.values()];
}
