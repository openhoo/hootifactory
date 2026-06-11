import { describe, expect, test } from "bun:test";
import { buildSmtpTransportOptions, renderEmail } from "./index";

describe("email rendering", () => {
  test("renders password reset messages with text and html bodies", () => {
    const rendered = renderEmail({
      template: "password_reset",
      to: "alice@example.test",
      resetUrl: "https://hoot.example.test/reset-password?token=abc",
      expiresAt: "2026-06-01T12:00:00.000Z",
      deliveryKey: "password-reset-1",
    });

    expect(rendered.to).toBe("alice@example.test");
    expect(rendered.subject).toContain("Reset");
    expect(rendered.text).toContain("https://hoot.example.test/reset-password?token=abc");
    expect(rendered.html).toContain("Reset password");
  });

  test("escapes OIDC provider names in html", () => {
    const rendered = renderEmail({
      template: "oidc_link",
      to: "alice@example.test",
      providerName: "<script>",
      linkUrl: "https://hoot.example.test/api/auth/oidc/link/confirm?token=abc",
      expiresAt: "2026-06-01T12:00:00.000Z",
      deliveryKey: "oidc-link-1",
    });

    expect(rendered.text).toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });

  test("requires STARTTLS for credentialed non-secure SMTP transports", () => {
    expect(
      buildSmtpTransportOptions({
        host: "smtp.example.test",
        port: 587,
        secure: false,
        requireTLS: true,
        user: "mailer",
        password: "secret",
      }),
    ).toMatchObject({
      secure: false,
      requireTLS: true,
      auth: { user: "mailer", pass: "secret" },
    });
  });
});
