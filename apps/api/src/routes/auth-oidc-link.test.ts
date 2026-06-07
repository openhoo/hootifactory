import { describe, expect, mock, test } from "bun:test";

// Stub the DB-backed email-token creation so createOidcLinkEmail can be exercised
// without Postgres; buildOidcLinkEmailJob is pure and tested directly.
const createAuthEmailToken = mock(async () => ({
  token: { id: "tok_123", expiresAt: new Date("2026-06-02T12:00:00.000Z") },
  secret: "hoot_email_token/with spaces",
}));
mock.module("@hootifactory/auth", () => ({ createAuthEmailToken }));

const { buildOidcLinkEmailJob, createOidcLinkEmail } = await import("./auth-oidc-link");

describe("OIDC link email jobs", () => {
  test("builds a confirmation email job with encoded token and stable delivery key", () => {
    expect(
      buildOidcLinkEmailJob({
        email: "user@example.test",
        secret: "hoot_email_token/with spaces",
        tokenId: "tok_123",
        expiresAt: new Date("2026-06-02T12:00:00.000Z"),
        providerName: "Example SSO",
        publicUrl: (path) => new URL(path, "https://app.example.test/").href,
      }),
    ).toEqual({
      template: "oidc_link",
      to: "user@example.test",
      linkUrl:
        "https://app.example.test/api/auth/oidc/link/confirm?token=hoot_email_token%2Fwith%20spaces",
      providerName: "Example SSO",
      expiresAt: "2026-06-02T12:00:00.000Z",
      deliveryKey: "oidc-link-tok_123",
    });
  });

  test("createOidcLinkEmail mints a token and assembles the email job", async () => {
    const { job } = await createOidcLinkEmail({
      userId: "user_1",
      email: "user@example.test",
      claims: { issuer: "https://idp.test", subject: "sub-1" } as never,
      returnTo: "/dashboard",
      ttlSeconds: 600,
      providerName: "Example SSO",
      publicUrl: (path) => new URL(path, "https://app.example.test/").href,
    });

    expect(createAuthEmailToken).toHaveBeenCalledTimes(1);
    expect(job.template).toBe("oidc_link");
    expect(job.to).toBe("user@example.test");
    expect(job.deliveryKey).toBe("oidc-link-tok_123");
  });
});
