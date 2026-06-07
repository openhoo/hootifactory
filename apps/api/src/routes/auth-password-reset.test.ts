import { describe, expect, mock, test } from "bun:test";

// Stub email-token creation so createPasswordResetEmail runs without Postgres;
// buildPasswordResetEmailJob is pure and tested directly.
const createAuthEmailToken = mock(async () => ({
  token: { id: "tok_123", expiresAt: new Date("2026-06-02T12:00:00.000Z") },
  secret: "hoot_email_token/with spaces",
}));
mock.module("@hootifactory/auth", () => ({ createAuthEmailToken }));

const { buildPasswordResetEmailJob, createPasswordResetEmail } = await import(
  "./auth-password-reset"
);

describe("password reset email jobs", () => {
  test("builds a reset email job with encoded token and stable delivery key", () => {
    expect(
      buildPasswordResetEmailJob({
        email: "user@example.test",
        secret: "hoot_email_token/with spaces",
        tokenId: "tok_123",
        expiresAt: new Date("2026-06-02T12:00:00.000Z"),
        publicUrl: (path) => new URL(path, "https://app.example.test/").href,
      }),
    ).toEqual({
      template: "password_reset",
      to: "user@example.test",
      resetUrl: "https://app.example.test/reset-password?token=hoot_email_token%2Fwith%20spaces",
      expiresAt: "2026-06-02T12:00:00.000Z",
      deliveryKey: "password-reset-tok_123",
    });
  });

  test("createPasswordResetEmail mints a token and assembles the email job", async () => {
    const { job } = await createPasswordResetEmail({
      userId: "user_1",
      email: "user@example.test",
      ttlSeconds: 900,
      publicUrl: (path) => new URL(path, "https://app.example.test/").href,
    });

    expect(createAuthEmailToken).toHaveBeenCalledTimes(1);
    expect(job.template).toBe("password_reset");
    expect(job.deliveryKey).toBe("password-reset-tok_123");
  });
});
