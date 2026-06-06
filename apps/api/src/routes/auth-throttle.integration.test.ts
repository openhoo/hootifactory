import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  authenticateUserPasswordWithThrottle,
  consumeOidcLinkEmailRequest,
  consumePasswordResetRequest,
  consumeRegistrationAttempt,
} from "./auth-throttle";

// These exercise the DB-backed throttle buckets (auth_throttle_buckets), so they
// need Postgres and run in the integration suite, not the hermetic unit run.
describe("auth throttle persistence", () => {
  test("throttles shared password verification buckets", async () => {
    const username = `basic-${randomUUID()}@example.test`;
    let calls = 0;
    const verify = async () => {
      calls += 1;
      return null;
    };

    for (let attempts = 1; attempts <= 5; attempts++) {
      await expect(
        authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.10", verify),
      ).resolves.toMatchObject({ kind: "invalid", failure: { count: attempts } });
    }

    await expect(
      authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.10", verify),
    ).resolves.toMatchObject({ kind: "throttled" });
    expect(calls).toBe(6);
  });

  test("throttles password verification across changing client addresses", async () => {
    const username = `spoofed-${randomUUID()}@example.test`;
    let calls = 0;
    const verify = async () => {
      calls += 1;
      return null;
    };

    for (let attempts = 1; attempts <= 5; attempts++) {
      await expect(
        authenticateUserPasswordWithThrottle(username, "wrong", `203.0.113.${attempts}`, verify),
      ).resolves.toMatchObject({ kind: "invalid", failure: { count: attempts } });
    }

    await expect(
      authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.250", verify),
    ).resolves.toMatchObject({ kind: "throttled" });
    expect(calls).toBe(6);
  });

  test("successful password verification clears prior shared failures within the budget", async () => {
    const username = `lockout-${randomUUID()}@example.test`;

    for (let attempts = 1; attempts <= 4; attempts++) {
      await expect(
        authenticateUserPasswordWithThrottle(
          username,
          "wrong",
          `203.0.113.${attempts}`,
          async () => null,
        ),
      ).resolves.toMatchObject({ kind: "invalid", failure: { count: attempts } });
    }

    await expect(
      authenticateUserPasswordWithThrottle(username, "right", "203.0.113.250", async () => ({
        kind: "user",
        userId: "user_1",
        username,
      })),
    ).resolves.toMatchObject({ kind: "authenticated", principal: { username } });

    await expect(
      authenticateUserPasswordWithThrottle(
        username,
        "wrong-again",
        "203.0.113.251",
        async () => null,
      ),
    ).resolves.toMatchObject({ kind: "invalid", failure: { count: 1 } });
  });

  test("throttles password reset requests across changing client addresses", async () => {
    const email = `reset-${randomUUID()}@example.test`;

    for (let attempts = 1; attempts <= 3; attempts++) {
      await expect(consumePasswordResetRequest(email, `203.0.113.${attempts}`)).resolves.toEqual({
        throttled: false,
        bucket: expect.objectContaining({ count: attempts }),
      });
    }

    await expect(consumePasswordResetRequest(email, "203.0.113.250")).resolves.toMatchObject({
      throttled: true,
    });
  });

  test("throttles OIDC link emails across changing client addresses", async () => {
    const email = `oidc-link-${randomUUID()}@example.test`;

    for (let attempts = 1; attempts <= 3; attempts++) {
      await expect(consumeOidcLinkEmailRequest(email, `203.0.113.${attempts}`)).resolves.toEqual({
        throttled: false,
        bucket: expect.objectContaining({ count: attempts }),
      });
    }

    await expect(consumeOidcLinkEmailRequest(email, "203.0.113.250")).resolves.toMatchObject({
      throttled: true,
    });
  });

  test("throttles registration probes by normalized email", async () => {
    const email = `register-${randomUUID()}@example.test`;

    for (let attempts = 1; attempts <= 3; attempts++) {
      await expect(consumeRegistrationAttempt(`probe-${randomUUID()}`, email)).resolves.toEqual({
        throttled: false,
        bucket: expect.objectContaining({ count: attempts }),
      });
    }

    await expect(consumeRegistrationAttempt(`probe-${randomUUID()}`, email)).resolves.toMatchObject(
      {
        throttled: true,
      },
    );
  });

  test("successful shared password verification clears prior failures", async () => {
    const username = `success-${randomUUID()}@example.test`;
    await authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.11", async () => null);

    await expect(
      authenticateUserPasswordWithThrottle(username, "right", "203.0.113.11", async () => ({
        kind: "user",
        userId: "user_1",
        username,
      })),
    ).resolves.toMatchObject({ kind: "authenticated", principal: { username } });

    await expect(
      authenticateUserPasswordWithThrottle(
        username,
        "wrong-again",
        "203.0.113.11",
        async () => null,
      ),
    ).resolves.toMatchObject({ kind: "invalid", failure: { count: 1 } });
  });
});
