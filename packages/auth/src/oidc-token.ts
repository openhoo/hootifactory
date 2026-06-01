import { createRemoteJWKSet, jwtVerify } from "jose";
import type { VerifyIdTokenOptions } from "./oidc-types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
}

/**
 * Securely verify an OIDC id_token: RS256/ES256 signature against the provider
 * JWKS, plus issuer, audience, expiry, and nonce when provided.
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
