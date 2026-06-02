import { describe, expect, test } from "bun:test";
import { buildPasswordResetEmailJob } from "./auth-password-reset";

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
});
