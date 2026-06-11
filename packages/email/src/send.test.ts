import { describe, expect, test } from "bun:test";
import type { Transporter } from "nodemailer";
import { closeEmailTransport, deliverEmail, sendEmail } from "./index";

type SentMessage = Record<string, unknown>;

interface FakeTransport extends Pick<Transporter, "sendMail"> {
  sent: SentMessage[];
}

// An in-memory transport injected into deliverEmail so the render/send/span
// logic runs without any SMTP connection or env coupling. `rejected` drives the
// failure path. The `result` object is returned from `sendMail` verbatim, so a
// test can omit `accepted`/`rejected`/`messageId` entirely to exercise
// deliverEmail's own `??` fallbacks on a genuinely missing field — the fake adds
// no defaults of its own.
function fakeTransport(result?: {
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
}): FakeTransport {
  const sent: SentMessage[] = [];
  // Default to a happy-path response with one accepted recipient and no
  // rejections; an explicit `result` (even one with missing keys) is returned
  // untouched so the missing-field path is real, not masked by the fake.
  const info = result ?? { messageId: "id-1", accepted: ["a@b.test"], rejected: [] };
  return {
    sent,
    sendMail: (async (message: SentMessage) => {
      sent.push(message);
      return info;
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

  test("stamps the message id for oidc-link jobs too (deliveryKey is mandatory)", async () => {
    const transport = fakeTransport();
    await deliverEmail(
      {
        template: "oidc_link",
        to: "a@b.test",
        providerName: "Okta",
        linkUrl: "https://hoot.test/link?token=xyz",
        expiresAt: "2026-06-01T12:00:00.000Z",
        deliveryKey: "oidc-link-xyz",
      },
      transport as unknown as Transporter,
    );
    expect(transport.sent[0]!.messageId).toBe("<oidc-link-xyz@hootifactory.local>");
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
          deliveryKey: "key-reset",
        },
        transport as unknown as Transporter,
      ),
    ).rejects.toThrow("email rejected for 1 recipient");
  });

  test("throws on a partial rejection even when some recipients were accepted", async () => {
    // deliverEmail treats transactional sends atomically: any non-empty
    // `rejected` fails the whole send, regardless of how many were accepted.
    const transport = fakeTransport({ accepted: ["ok@b.test"], rejected: ["bad@b.test"] });
    await expect(
      deliverEmail(
        {
          template: "password_reset",
          to: "ok@b.test",
          resetUrl: "https://hoot.test/reset",
          expiresAt: "2026-06-01T12:00:00.000Z",
          deliveryKey: "key-reset",
        },
        transport as unknown as Transporter,
      ),
    ).rejects.toThrow("email rejected for 1 recipient");
  });

  test("tolerates an SMTP response with truly-missing accepted/rejected/messageId", async () => {
    // The transport returns a bare object whose accepted/rejected/messageId keys
    // are genuinely absent, so deliverEmail must rely on its own `??` fallbacks
    // (rejected absent => no rejections => resolves). The fake adds no defaults,
    // so this exercises the missing-field path for real rather than vacuously.
    const transport = fakeTransport({});
    await expect(
      deliverEmail(
        {
          template: "password_reset",
          to: "a@b.test",
          resetUrl: "https://hoot.test/reset",
          expiresAt: "2026-06-01T12:00:00.000Z",
          deliveryKey: "key-reset",
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
        deliveryKey: "key-reset",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("closeEmailTransport", () => {
  test("is a no-op when no transport has been created", () => {
    expect(() => closeEmailTransport()).not.toThrow();
  });
});
