import type { OidcGroupGrant, OidcGroupMappings } from "./oidc-types";
import { roleOutranks } from "./permissions";

// `mapGroupsToOrgRoles` / `groupMappings` is the multi-org group->role mapping
// used by resolveOidcCallbackClaims (oidc-client.ts). The highest-privilege
// matching role wins per org.

export function mapGroupsToOrgRoles(
  groups: string[],
  groupMappings: OidcGroupMappings,
): OidcGroupGrant[] {
  const byOrg = new Map<string, OidcGroupGrant>();
  for (const group of groups) {
    const grants = Object.hasOwn(groupMappings, group) ? groupMappings[group] : undefined;
    for (const grant of grants ?? []) {
      const existing = byOrg.get(grant.org);
      if (!existing || roleOutranks(grant.role, existing.role)) {
        byOrg.set(grant.org, { org: grant.org, role: grant.role, groups: [group] });
      } else if (existing.role === grant.role && !existing.groups.includes(group)) {
        existing.groups.push(group);
      }
    }
  }
  return [...byOrg.values()];
}
