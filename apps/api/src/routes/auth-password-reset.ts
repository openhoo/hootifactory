import { createAuthEmailToken } from "@hootifactory/auth";
import type { EmailJob } from "@hootifactory/email";
import { AUTH_EMAIL_TOKEN_PURPOSE, EMAIL_TEMPLATE } from "@hootifactory/types";

type PublicUrlBuilder = (path: string) => string;

export type PasswordResetEmailJobInput = {
  email: string;
  secret: string;
  tokenId: string;
  expiresAt: Date;
  publicUrl: PublicUrlBuilder;
};

export function buildPasswordResetEmailJob({
  email,
  secret,
  tokenId,
  expiresAt,
  publicUrl,
}: PasswordResetEmailJobInput): EmailJob {
  return {
    template: EMAIL_TEMPLATE.passwordReset,
    to: email,
    resetUrl: publicUrl(`/reset-password?token=${encodeURIComponent(secret)}`),
    expiresAt: expiresAt.toISOString(),
    deliveryKey: `password-reset-${tokenId}`,
  };
}

export async function createPasswordResetEmail(input: {
  userId: string;
  email: string;
  ttlSeconds: number;
  publicUrl: PublicUrlBuilder;
}): Promise<{ job: EmailJob }> {
  const { token, secret } = await createAuthEmailToken({
    purpose: AUTH_EMAIL_TOKEN_PURPOSE.passwordReset,
    userId: input.userId,
    email: input.email,
    ttlSeconds: input.ttlSeconds,
  });
  return {
    job: buildPasswordResetEmailJob({
      email: input.email,
      secret,
      tokenId: token.id,
      expiresAt: token.expiresAt,
      publicUrl: input.publicUrl,
    }),
  };
}
