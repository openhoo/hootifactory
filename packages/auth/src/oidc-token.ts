import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { memoizeByKey } from "./memo";
import type { VerifyIdTokenOptions } from "./oidc-types";

const jwks = memoizeByKey((uri: string) => createRemoteJWKSet(new URL(uri)));
const OidcClaimsRecordSchema = z.record(z.string(), z.unknown());

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
  const claims = OidcClaimsRecordSchema.safeParse(payload);
  if (!claims.success) throw new Error("oidc: invalid id_token payload");
  return claims.data;
}
