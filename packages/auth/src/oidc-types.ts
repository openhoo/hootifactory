import type { RoleName } from "./permissions";

export const OIDC_PROVIDER = "oidc";

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  groupClaim: string;
  groupRoleMap?: Record<string, string>;
  groupMappings?: OidcGroupMappings;
  emailClaim?: string;
  usernameClaim?: string;
}

export interface OidcGroupGrant {
  org: string;
  role: RoleName;
  groups: string[];
}

export type OidcGroupMappings = Record<string, { org: string; role: RoleName }[]>;

export interface SignedOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface OidcCallbackClaims {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  username: string | null;
  displayName: string | null;
  groups: string[];
  grants: OidcGroupGrant[];
}

export interface SyncOidcUserInput extends OidcCallbackClaims {}

export interface SyncedOidcUser {
  id: string;
  username: string;
}

export interface SyncOidcUserOptions {
  allowExistingEmailLink?: boolean;
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
