import * as client from "openid-client";
import { extractGroups, extractStringClaim, mapGroupsToOrgRoles } from "./oidc-claims";
import { safeOidcReturnTo } from "./oidc-state";
import type { OidcCallbackClaims, OidcProviderConfig, SignedOidcState } from "./oidc-types";

function oidcDiscoveryOptions(issuer: string): client.DiscoveryRequestOptions | undefined {
  if (!issuer.startsWith("http://")) return undefined;
  return { execute: [client.allowInsecureRequests] };
}

const configCache = new Map<string, Promise<client.Configuration>>();

export async function oidcClientConfig(config: OidcProviderConfig): Promise<client.Configuration> {
  if (!config.clientSecret) throw new Error("oidc: client secret is required");
  const cacheKey = `${config.issuer}\0${config.clientId}\0${config.clientSecret}`;
  let cached = configCache.get(cacheKey);
  if (!cached) {
    cached = client.discovery(
      new URL(config.issuer),
      config.clientId,
      config.clientSecret,
      client.ClientSecretPost(config.clientSecret),
      oidcDiscoveryOptions(config.issuer),
    );
    configCache.set(cacheKey, cached);
  }
  return cached;
}

export async function createOidcAuthorizationRequest(
  config: OidcProviderConfig,
  redirectUri: string,
  returnTo: string,
  ttlSeconds = 300,
): Promise<{ url: URL; state: SignedOidcState }> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const oidcConfig = await oidcClientConfig(config);
  const url = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: redirectUri,
    scope: (config.scopes ?? ["openid", "profile", "email", "groups"]).join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return {
    url,
    state: {
      state,
      nonce,
      codeVerifier,
      returnTo: safeOidcReturnTo(returnTo),
      expiresAt: Date.now() + ttlSeconds * 1000,
    },
  };
}

export async function resolveOidcCallbackClaims(
  config: OidcProviderConfig,
  currentUrl: URL,
  expected: SignedOidcState,
): Promise<OidcCallbackClaims> {
  const oidcConfig = await oidcClientConfig(config);
  const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
    expectedState: expected.state,
    expectedNonce: expected.nonce,
    pkceCodeVerifier: expected.codeVerifier,
  });
  const idClaims = tokens.claims();
  if (!idClaims?.sub) throw new Error("oidc: missing id_token subject");

  let claims: Record<string, unknown> = idClaims as Record<string, unknown>;
  if (tokens.access_token) {
    try {
      const userInfo = await client.fetchUserInfo(oidcConfig, tokens.access_token, idClaims.sub);
      claims = { ...(userInfo as Record<string, unknown>), ...claims };
    } catch {
      // UserInfo is useful for group/email claims, but an ID-token-only provider is valid.
    }
  }

  const groups = extractGroups(claims, config.groupClaim);
  const groupMappings = config.groupMappings ?? {};
  return {
    issuer: config.issuer,
    subject: idClaims.sub,
    email: extractStringClaim(claims, config.emailClaim ?? "email")?.toLowerCase() ?? null,
    emailVerified: claims.email_verified === true,
    username: extractStringClaim(claims, config.usernameClaim ?? "preferred_username"),
    displayName: extractStringClaim(claims, "name"),
    groups,
    grants: mapGroupsToOrgRoles(groups, groupMappings),
  };
}
