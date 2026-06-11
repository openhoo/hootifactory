import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loadEnv } from "@hootifactory/config";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Contained mocks: stub only the sibling modules the local-auth routes touch so
// every branch (register/login/logout/me) runs without DB, queue, or argon2id.
const createLocalUser = mock(async () => ({
  id: "user_1",
  username: "alice",
  email: "alice@example.test",
}));
const revokeSession = mock(async () => {});
const createRequestSession = mock(async () => {});
const authenticateUserPasswordWithThrottle = mock(
  async () =>
    ({ kind: "invalid", failure: { count: 1, resetAt: Date.now() + 1000 } }) as
      | { kind: "authenticated"; principal: { kind: "user"; userId: string; username: string } }
      | { kind: "invalid"; failure: { count: number; resetAt: number } }
      | { kind: "throttled"; retryAfter: number },
);
const consumeRegistrationAttempt = mock(
  async () =>
    ({ throttled: false, bucket: { count: 0, resetAt: 0 } }) as
      | { throttled: false; bucket: { count: number; resetAt: number } }
      | { throttled: true; retryAfter: number },
);
const breachedPasswordRejection = mock(async (..._args: unknown[]) => null as Response | null);

const env = { ...loadEnv(), AUTH_ALLOW_REGISTRATION: true };

mock.module("@hootifactory/config", () => ({ env, loadEnv }));
mock.module("@hootifactory/auth", () => ({ createLocalUser, revokeSession }));
mock.module("./auth-helpers", () => ({
  clientIp: () => "203.0.113.9",
  createRequestSession,
  deleteSessionCookie: (c: { header: (k: string, v: string) => void }) =>
    c.header("set-cookie", "hoot_session=; Max-Age=0"),
  readSessionCookie: () => undefined,
}));
mock.module("./auth-password-policy", () => ({ breachedPasswordRejection }));
mock.module("./auth-throttle", () => ({
  authenticateUserPasswordWithThrottle,
  consumeRegistrationAttempt,
}));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
}));

const { registerLocalAuthRoutes } = await import("./auth-local-routes");

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", { kind: "anonymous" });
    await next();
  });
  registerLocalAuthRoutes(router);
  return router;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("local auth routes", () => {
  beforeEach(() => {
    createLocalUser.mockClear();
    revokeSession.mockClear();
    createRequestSession.mockClear();
    authenticateUserPasswordWithThrottle.mockClear();
    consumeRegistrationAttempt.mockClear();
    breachedPasswordRejection.mockClear();
    env.AUTH_ALLOW_REGISTRATION = true;
  });

  test("register rejects invalid request bodies", async () => {
    const res = await appWithRoutes().fetch(postJson("/register", { username: "x" }));
    expect(res.status).toBe(400);
  });

  test("register creates a user and starts a session", async () => {
    const res = await appWithRoutes().fetch(
      postJson("/register", {
        username: "alice",
        email: "alice@example.test",
        password: "supersecret123",
        displayName: "Alice",
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      user: { id: "user_1", username: "alice", email: "alice@example.test" },
    });
    expect(createRequestSession).toHaveBeenCalledTimes(1);
  });

  test("register is rejected when registration is disabled", async () => {
    env.AUTH_ALLOW_REGISTRATION = false;
    const res = await appWithRoutes().fetch(
      postJson("/register", {
        username: "alice",
        email: "alice@example.test",
        password: "supersecret123",
      }),
    );
    expect(res.status).toBe(403);
  });

  test("register is throttled when the limiter trips", async () => {
    consumeRegistrationAttempt.mockResolvedValueOnce({ throttled: true, retryAfter: 30 });
    const res = await appWithRoutes().fetch(
      postJson("/register", {
        username: "alice",
        email: "alice@example.test",
        password: "supersecret123",
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  test("register rejects passwords found in known breaches", async () => {
    breachedPasswordRejection.mockImplementationOnce(async () =>
      Response.json(
        { error: "this password appears in known data breaches; choose a different one" },
        { status: 400 },
      ),
    );
    const res = await appWithRoutes().fetch(
      postJson("/register", {
        username: "alice",
        email: "alice@example.test",
        password: "password1234",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "this password appears in known data breaches; choose a different one",
    });
    expect(createLocalUser).not.toHaveBeenCalled();
  });

  test("register maps unique violations to a 409 conflict", async () => {
    createLocalUser.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );
    const res = await appWithRoutes().fetch(
      postJson("/register", {
        username: "alice",
        email: "alice@example.test",
        password: "supersecret123",
      }),
    );
    expect(res.status).toBe(409);
  });

  test("login rejects invalid bodies", async () => {
    const res = await appWithRoutes().fetch(postJson("/login", {}));
    expect(res.status).toBe(400);
  });

  test("login returns 401 on invalid credentials", async () => {
    const res = await appWithRoutes().fetch(
      postJson("/login", { username: "alice", password: "wrong-password" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid credentials" });
  });

  test("login returns 429 when throttled", async () => {
    authenticateUserPasswordWithThrottle.mockResolvedValueOnce({
      kind: "throttled",
      retryAfter: 12,
    });
    const res = await appWithRoutes().fetch(
      postJson("/login", { username: "alice", password: "wrong-password" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });

  test("login succeeds and starts a session", async () => {
    authenticateUserPasswordWithThrottle.mockResolvedValueOnce({
      kind: "authenticated",
      principal: { kind: "user", userId: "user_1", username: "alice" },
    });
    const res = await appWithRoutes().fetch(
      postJson("/login", { username: "alice", password: "right-password" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "user_1", username: "alice" } });
    expect(createRequestSession).toHaveBeenCalledTimes(1);
  });

  test("logout clears the session cookie", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/logout", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("me returns 401 for anonymous callers", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/me"));
    expect(res.status).toBe(401);
  });
});
