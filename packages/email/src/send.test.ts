import { describe, expect, test } from "bun:test";
import type { Transporter } from "nodemailer";
import { closeEmailTransport, deliverEmail, sendEmail } from "./index";

type SentMessage = Record<string, unknown>;

interface FakeTransport extends Pick<Transporter, "sendMail"> {
  sent: SentMessage[];
}

// An in-memory transport injected into deliverEmail so the render/send/span
// logic runs without any SMTP connection or env coupling. `rejected` drives the
// failure path.
function fakeTransport(
  result: { messageId?: string; accepted?: unknown[]; rejected?: unknown[] } = {},
): FakeTransport {
  const sent: SentMessage[] = [];
  return {
    sent,
    sendMail: (async (message: SentMessage) => {
      sent.push(message);
      return {
        messageId: result.messageId ?? "id-1",
        accepted: result.accepted ?? ["a@b.test"],
        rejected: result.rejected ?? [],
      };
    }) as Transporter["sendMail"],
  };
}

describe("deliverEmail", () => {
  test("renders and sends a password-reset job, stamping a deterministic message id", async () => {
    const transport = fakeTransport();
    await deliverEmail(
      {
        template: "password_reset",
        to: "a@b.test",
        resetUrl: "https://hoot.test/reset?token=abc",
        expiresAt: "2026-06-01T12:00:00.000Z",
        deliveryKey: "key-123",
      },
      transport as unknown as Transporter,
    );

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0]!;
    expect(message.to).toBe("a@b.test");
    expect(String(message.subject)).toContain("Reset");
    expect(String(message.text)).toContain("https://hoot.test/reset?token=abc");
    // deliveryKey becomes a stable Message-ID for idempotent delivery.
    expect(message.messageId).toBe("<key-123@hootifactory.local>");
  });

  test("omits the message id when no delivery key is supplied", async () => {
    const transport = fakeTransport();
    await deliverEmail(
      {
        template: "oidc_link",
        to: "a@b.test",
        providerName: "Okta",
        linkUrl: "https://hoot.test/link?token=xyz",
        expiresAt: "2026-06-01T12:00:00.000Z",
      },
      transport as unknown as Transporter,
    );
    expect(transport.sent[0]!.messageId).toBeUndefined();
  });

  test("throws when the SMTP server rejects every recipient", async () => {
    const transport = fakeTransport({ accepted: [], rejected: ["a@b.test"] });
    await expect(
      deliverEmail(
        {
          template: "password_reset",
          to: "a@b.test",
          resetUrl: "https://hoot.test/reset",
          expiresAt: "2026-06-01T12:00:00.000Z",
        },
        transport as unknown as Transporter,
      ),
    ).rejects.toThrow("email rejected for 1 recipient");
  });

  test("tolerates an SMTP response missing accepted/rejected arrays", async () => {
    const transport = fakeTransport({ messageId: undefined, accepted: undefined });
    // accepted/rejected default away; with no rejections this must resolve.
    await expect(
      deliverEmail(
        {
          template: "password_reset",
          to: "a@b.test",
          resetUrl: "https://hoot.test/reset",
          expiresAt: "2026-06-01T12:00:00.000Z",
        },
        transport as unknown as Transporter,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("sendEmail", () => {
  // EMAIL_ENABLED defaults to false in the test environment, so sendEmail takes
  // the skip branch: it must resolve without attempting any SMTP delivery.
  test("skips delivery when email is disabled", async () => {
    await expect(
      sendEmail({
        template: "password_reset",
        to: "a@b.test",
        resetUrl: "https://hoot.test/reset",
        expiresAt: "2026-06-01T12:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("closeEmailTransport", () => {
  test("is a no-op when no transport has been created", () => {
    expect(() => closeEmailTransport()).not.toThrow();
  });
});
