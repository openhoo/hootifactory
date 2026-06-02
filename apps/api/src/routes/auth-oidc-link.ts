import { createAuthEmailToken, type OidcCallbackClaims } from "@hootifactory/auth";
import type { EmailJob } from "@hootifactory/email";

type PublicUrlBuilder = (path: string) => string;

export type OidcLinkEmailJobInput = {
  email: string;
  secret: string;
  tokenId: string;
  expiresAt: Date;
  providerName: string;
  publicUrl: PublicUrlBuilder;
};

export function buildOidcLinkEmailJob({
  email,
  secret,
  tokenId,
  expiresAt,
  providerName,
  publicUrl,
}: OidcLinkEmailJobInput): EmailJob {
  return {
    template: "oidc_link",
    to: email,
    linkUrl: publicUrl(`/api/auth/oidc/link/confirm?token=${encodeURIComponent(secret)}`),
    providerName,
    expiresAt: expiresAt.toISOString(),
    deliveryKey: `oidc-link-${tokenId}`,
  };
}

export async function createOidcLinkEmail(input: {
  userId: string;
  email: string;
  claims: OidcCallbackClaims;
  returnTo: string;
  ttlSeconds: number;
  providerName: string;
  publicUrl: PublicUrlBuilder;
}): Promise<{ job: EmailJob }> {
  const { token, secret } = await createAuthEmailToken({
    purpose: "oidc_link",
    userId: input.userId,
    email: input.email,
    ttlSeconds: input.ttlSeconds,
    metadata: { claims: input.claims, returnTo: input.returnTo },
  });
  return {
    job: buildOidcLinkEmailJob({
      email: input.email,
      secret,
      tokenId: token.id,
      expiresAt: token.expiresAt,
      providerName: input.providerName,
      publicUrl: input.publicUrl,
    }),
  };
}
