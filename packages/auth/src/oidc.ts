import { ROLE_RANK, type RoleName } from "./permissions";

/**
 * Map IdP group claims to an org role using a provider's group->role map.
 * The highest-privilege matching role wins. Returns null if no group maps.
 *
 * This is the core of SSO authorization; the OAuth/OIDC exchange itself is a
 * thin layer that resolves the user + their group claims, then calls this.
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

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  groupClaim: string;
  groupRoleMap: Record<string, string>;
}

/** Extract group claims from an OIDC ID-token payload using the configured claim path. */
export function extractGroups(payload: Record<string, unknown>, groupClaim: string): string[] {
  const raw = payload[groupClaim];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === "string");
  if (typeof raw === "string") return [raw];
  return [];
}
