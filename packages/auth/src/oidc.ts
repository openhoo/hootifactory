import { createRemoteJWKSet, jwtVerify } from "jose";
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

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
}

export interface VerifyIdTokenOptions {
  /** Expected token issuer (provider.issuer). */
  issuer: string;
  /** Expected audience (provider.clientId). */
  clientId: string;
  /** The provider's JWKS endpoint (from OIDC discovery). */
  jwksUri: string;
  /** The nonce sent in the auth request; must match the id_token claim. */
  nonce?: string;
}

/**
 * Securely verify an OIDC id_token: RS256/ES256 signature against the provider
 * JWKS, plus issuer, audience, expiry, and (when provided) nonce. Returns the
 * validated claims. The OAuth callback route should call this before trusting
 * any claim (e.g. before mapGroupsToRole) — never decode an id_token unverified.
 */
export async function verifyIdToken(
  idToken: string,
  opts: VerifyIdTokenOptions,
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(idToken, jwks(opts.jwksUri), {
    issuer: opts.issuer,
    audience: opts.clientId,
    algorithms: ["RS256", "ES256"],
  });
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) {
    throw new Error("oidc: id_token nonce mismatch");
  }
  return payload as Record<string, unknown>;
}
