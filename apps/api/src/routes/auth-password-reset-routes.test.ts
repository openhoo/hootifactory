import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loadEnv } from "@hootifactory/config";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Regression test for #223: POST /password-reset/request must run the same
// normalization path for registered and unknown emails so response latency
// cannot leak account existence. We assert on the code path (which work
// function is invoked) rather than wall-clock timing, which is flaky.

const PASSWORD_RESET_USER = { id: "user-1", email: "known@example.test" };

// Spies that record which normalization branch ran for a given request.
const findPasswordResetUser = mock(
  async (_email: string) => null as typeof PASSWORD_RESET_USER | null,
);
const dummyPasswordResetWork = mock(async () => {});
const resetPasswordWithToken = mock(async () => null as { userId: string } | null);
const createPasswordResetEmail = mock(async () => ({
  job: { template: "password_reset", to: "known@example.test", deliveryKey: "k" },
}));
const enqueueEmail = mock(async () => {});
const consumePasswordResetRequest = mock(
  async () =>
    ({ throttled: false, bucket: { count: 0, resetAt: 0 } }) as
      | { throttled: false; bucket: { count: number; resetAt: number } }
      | { throttled: true; retryAfter: number },
);

// Email must be enabled for the handler to reach the normalization branches.
const env = { ...loadEnv(), EMAIL_ENABLED: true };

mock.module("@hootifactory/config", () => ({ env, loadEnv }));
mock.module("@hootifactory/auth", () => ({
  findPasswordResetUser,
  dummyPasswordResetWork,
  resetPasswordWithToken,
}));
mock.module("./auth-password-reset", () => ({ createPasswordResetEmail }));
mock.module("./auth-helpers", () => ({
  enqueueEmail,
  clientIp: () => "203.0.113.7",
  publicUrl: (path: string) => `https://app.example.test${path}`,
}));
mock.module("./auth-throttle", () => ({ consumePasswordResetRequest }));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
}));

const { registerPasswordResetRoutes } = await import("./auth-password-reset-routes");

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  registerPasswordResetRoutes(router);
  return router;
}

function requestReset(email: string): Request {
  return new Request("http://localhost/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

describe("password reset request timing normalization (#223)", () => {
  beforeEach(() => {
    findPasswordResetUser.mockClear();
    dummyPasswordResetWork.mockClear();
    createPasswordResetEmail.mockClear();
    enqueueEmail.mockClear();
    resetPasswordWithToken.mockClear();
    consumePasswordResetRequest.mockClear();
    env.EMAIL_ENABLED = true;
  });

  test("unknown email runs the dummy normalization work and returns ok", async () => {
    findPasswordResetUser.mockResolvedValueOnce(null);
    const router = appWithRoutes();

    const response = await router.fetch(requestReset("missing@example.test"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // No-user branch performs the constant-time dummy work, never real work.
    expect(dummyPasswordResetWork).toHaveBeenCalledTimes(1);
    expect(createPasswordResetEmail).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  test("known email runs the real token+enqueue path and returns ok", async () => {
    findPasswordResetUser.mockResolvedValueOnce(PASSWORD_RESET_USER);
    const router = appWithRoutes();

    const response = await router.fetch(requestReset(PASSWORD_RESET_USER.email));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // Real branch performs token creation + email enqueue, never the dummy work.
    expect(createPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(dummyPasswordResetWork).not.toHaveBeenCalled();
  });

  test("unknown email still returns ok when the dummy work throws", async () => {
    findPasswordResetUser.mockResolvedValueOnce(null);
    dummyPasswordResetWork.mockRejectedValueOnce(new Error("transient db error"));
    const router = appWithRoutes();

    const response = await router.fetch(requestReset("missing@example.test"));

    // A failure in the throwaway work must not surface as a 500 — that asymmetry
    // (user branch swallows errors, no-user branch 500s) would re-open the
    // enumeration side channel #223 closes.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(dummyPasswordResetWork).toHaveBeenCalledTimes(1);
  });

  test("both branches always return the same neutral body", async () => {
    const router = appWithRoutes();

    findPasswordResetUser.mockResolvedValueOnce(null);
    const unknown = await router.fetch(requestReset("missing@example.test"));
    findPasswordResetUser.mockResolvedValueOnce(PASSWORD_RESET_USER);
    const known = await router.fetch(requestReset(PASSWORD_RESET_USER.email));

    const [unknownBody, knownBody] = await Promise.all([unknown.json(), known.json()]);
    expect(unknownBody).toEqual(knownBody);
    expect(unknownBody).toEqual({ ok: true });
  });

  test("rejects invalid request bodies", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 429 when the request is throttled", async () => {
    consumePasswordResetRequest.mockResolvedValueOnce({ throttled: true, retryAfter: 30 });
    const res = await appWithRoutes().fetch(requestReset("known@example.test"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  test("short-circuits to ok when email delivery is disabled", async () => {
    env.EMAIL_ENABLED = false;
    const res = await appWithRoutes().fetch(requestReset("known@example.test"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(findPasswordResetUser).not.toHaveBeenCalled();
  });

  test("swallows email-send failures and still returns ok", async () => {
    findPasswordResetUser.mockResolvedValueOnce(PASSWORD_RESET_USER);
    createPasswordResetEmail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await appWithRoutes().fetch(requestReset("known@example.test"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("password reset confirmation", () => {
  beforeEach(() => {
    resetPasswordWithToken.mockClear();
    env.EMAIL_ENABLED = true;
  });

  function confirm(body: unknown): Request {
    return new Request("http://localhost/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("rejects invalid confirmation bodies", async () => {
    const res = await appWithRoutes().fetch(confirm({ token: "short" }));
    expect(res.status).toBe(400);
  });

  test("returns 400 for an invalid or expired token", async () => {
    resetPasswordWithToken.mockResolvedValueOnce(null);
    const res = await appWithRoutes().fetch(
      confirm({ token: "a".repeat(20), password: "supersecret123" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid or expired reset token" });
  });

  test("confirms a valid reset token", async () => {
    resetPasswordWithToken.mockResolvedValueOnce({ userId: "user-1" });
    const res = await appWithRoutes().fetch(
      confirm({ token: "a".repeat(20), password: "supersecret123" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
