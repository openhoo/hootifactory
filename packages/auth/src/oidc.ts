import { timingSafeEqual } from "node:crypto";
import {
  and,
  db,
  eq,
  externalIdentities,
  externalRoleGrants,
  inArray,
  organizations,
  users,
} from "@hootifactory/db";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as client from "openid-client";
import { ROLE_RANK, type RoleName } from "./permissions";

export const OIDC_PROVIDER = "oidc";

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
    for (const grant of groupMappings[group] ?? []) {
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

export interface SignedOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

function hmacHex(secret: string, body: string): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return h.digest("hex");
}

export function safeOidcReturnTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "http://hootifactory.local");
    if (parsed.origin !== "http://hootifactory.local") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

export function signOidcState(payload: SignedOidcState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacHex(secret, body)}`;
}

export function verifyOidcState(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): SignedOidcState | null {
  const [body, sig, extra] = value?.split(".") ?? [];
  if (!body || !sig || extra !== undefined) return null;
  const expected = hmacHex(secret, body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isSignedOidcState(parsed) || parsed.expiresAt < now) return null;
  return parsed;
}

function isSignedOidcState(value: unknown): value is SignedOidcState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === "string" &&
    typeof v.nonce === "string" &&
    typeof v.codeVerifier === "string" &&
    typeof v.returnTo === "string" &&
    typeof v.expiresAt === "number"
  );
}

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

export interface SyncOidcUserInput extends OidcCallbackClaims {}

export interface SyncedOidcUser {
  id: string;
  username: string;
}

export interface SyncOidcUserOptions {
  allowExistingEmailLink?: boolean;
}

export class OidcEmailLinkRequiredError extends Error {
  constructor(
    public readonly userId: string,
    public readonly email: string,
  ) {
    super("oidc: email link confirmation required");
    this.name = "OidcEmailLinkRequiredError";
  }
}

function normalizeUsername(value: string | null, fallback: string): string {
  const base = (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return base || `oidc-${crypto.randomUUID().slice(0, 8)}`;
}

async function uniqueUsername(value: string | null, fallback: string): Promise<string> {
  const base = normalizeUsername(value, fallback);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 96)}-${i}`;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${base.slice(0, 80)}-${crypto.randomUUID().slice(0, 12)}`;
}

export async function syncOidcUser(
  input: SyncOidcUserInput,
  options: SyncOidcUserOptions = {},
): Promise<SyncedOidcUser> {
  if (input.grants.length === 0) throw new Error("oidc: no mapped groups");
  const mappedSlugs = [...new Set(input.grants.map((grant) => grant.org))];
  const orgRows = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(inArray(organizations.slug, mappedSlugs));
  const orgBySlug = new Map(orgRows.map((org) => [org.slug, org.id]));
  const validGrants = input.grants
    .map((grant) => ({ ...grant, orgId: orgBySlug.get(grant.org) }))
    .filter((grant): grant is OidcGroupGrant & { orgId: string } => Boolean(grant.orgId));
  if (validGrants.length === 0) throw new Error("oidc: no mapped organizations exist");

  return db.transaction(async (tx) => {
    const [linked] = await tx
      .select({ user: users })
      .from(externalIdentities)
      .innerJoin(users, eq(externalIdentities.userId, users.id))
      .where(
        and(
          eq(externalIdentities.provider, OIDC_PROVIDER),
          eq(externalIdentities.issuer, input.issuer),
          eq(externalIdentities.subject, input.subject),
        ),
      )
      .limit(1);

    let user = linked?.user ?? null;
    if (user && !user.isActive) throw new Error("oidc: linked user is disabled");

    if (!user && input.email) {
      const [existing] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
      if (existing && !existing.isActive) {
        throw new Error("oidc: existing user is disabled");
      }
      if (existing && !options.allowExistingEmailLink) {
        throw new OidcEmailLinkRequiredError(existing.id, existing.email);
      }
      user = existing ?? null;
    }

    if (!user) {
      if (!input.email) throw new Error("oidc: email claim is required to create a user");
      const username = await uniqueUsername(
        input.username,
        input.email.split("@")[0] ?? input.subject,
      );
      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          username,
          displayName: input.displayName ?? username,
          passwordHash: null,
          externalIdp: { issuer: input.issuer, subject: input.subject },
        })
        .returning();
      if (!created) throw new Error("oidc: failed to create user");
      user = created;
    } else {
      await tx
        .update(users)
        .set({
          externalIdp: { issuer: input.issuer, subject: input.subject },
          displayName: user.displayName ?? input.displayName ?? user.username,
        })
        .where(eq(users.id, user.id));
    }

    await tx
      .insert(externalIdentities)
      .values({
        provider: OIDC_PROVIDER,
        issuer: input.issuer,
        subject: input.subject,
        userId: user.id,
        email: input.email,
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          externalIdentities.provider,
          externalIdentities.issuer,
          externalIdentities.subject,
        ],
        set: { userId: user.id, email: input.email, lastLoginAt: new Date() },
      });

    await tx
      .delete(externalRoleGrants)
      .where(
        and(
          eq(externalRoleGrants.provider, OIDC_PROVIDER),
          eq(externalRoleGrants.issuer, input.issuer),
          eq(externalRoleGrants.userId, user.id),
        ),
      );
    await tx.insert(externalRoleGrants).values(
      validGrants.map((grant) => ({
        provider: OIDC_PROVIDER,
        issuer: input.issuer,
        userId: user.id,
        orgId: grant.orgId,
        role: grant.role,
        groups: grant.groups,
      })),
    );

    return { id: user.id, username: user.username };
  });
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
