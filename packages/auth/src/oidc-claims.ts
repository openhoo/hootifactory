import type { OidcGroupGrant, OidcGroupMappings } from "./oidc-types";
import { ROLE_RANK, type RoleName } from "./permissions";

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

function claimValue(payload: Record<string, unknown>, claimPath: string): unknown {
  let current: unknown = payload;
  for (const part of claimPath.split(".")) {
    if (!part || typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Extract group claims from an OIDC ID-token payload using the configured claim path. */
export function extractGroups(payload: Record<string, unknown>, groupClaim: string): string[] {
  const raw = claimValue(payload, groupClaim);
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === "string");
  if (typeof raw === "string") return [raw];
  return [];
}

export function extractStringClaim(
  payload: Record<string, unknown>,
  claimPath: string,
): string | null {
  const raw = claimValue(payload, claimPath);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

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
