import { describe, expect, test } from "bun:test";
import type { EmailJob } from "./index";
import { InvalidEmailJobError, parseEmailJob } from "./index";

const passwordResetJob: EmailJob = {
  template: "password_reset",
  to: "alice@example.test",
  resetUrl: "https://hoot.example.test/reset-password?token=abc",
  expiresAt: "2026-06-01T12:00:00.000Z",
  deliveryKey: "password-reset-1",
};

const oidcLinkJob: EmailJob = {
  template: "oidc_link",
  to: "alice@example.test",
  linkUrl: "https://hoot.example.test/api/auth/oidc/link/confirm?token=abc",
  providerName: "Example IdP",
  expiresAt: "2026-06-01T12:00:00.000Z",
  deliveryKey: "oidc-link-1",
};

describe("parseEmailJob (issue #308)", () => {
  test("accepts both well-formed job variants", () => {
    expect(parseEmailJob(passwordResetJob)).toEqual(passwordResetJob);
    expect(parseEmailJob(oidcLinkJob)).toEqual(oidcLinkJob);
  });

  test("strips the telemetry context carrier stamped at enqueue", () => {
    const onTheWire = { ...passwordResetJob, telemetry: { requestId: "req-1" } };
    expect(parseEmailJob(onTheWire)).toEqual(passwordResetJob);
  });

  test("rejects a payload missing its mandatory deliveryKey", () => {
    const { deliveryKey: _dropped, ...withoutKey } = passwordResetJob;
    expect(() => parseEmailJob(withoutKey)).toThrow(InvalidEmailJobError);
    expect(() => parseEmailJob(withoutKey)).toThrow(/deliveryKey/);
  });

  test("rejects an unknown template with a readable error", () => {
    const err = (() => {
      try {
        parseEmailJob({ ...passwordResetJob, template: "marketing_blast" });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(InvalidEmailJobError);
    expect((err as Error).message).toContain("invalid email job payload");
    expect((err as Error).message).toContain("template");
  });

  test("rejects non-object payloads", () => {
    expect(() => parseEmailJob(null)).toThrow(InvalidEmailJobError);
    expect(() => parseEmailJob("password_reset")).toThrow(InvalidEmailJobError);
  });

  test("rejects a template/field mismatch (oidc_link without linkUrl)", () => {
    const { linkUrl: _dropped, ...withoutLink } = oidcLinkJob;
    expect(() => parseEmailJob(withoutLink)).toThrow(InvalidEmailJobError);
  });
});
