import { describe, expect, test } from "bun:test";
import { buildOidcLinkEmailJob } from "./auth-oidc-link";

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
});
