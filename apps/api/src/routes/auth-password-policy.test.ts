import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Contained mocks: stub the auth package's HIBP client and the observability
// sinks so both policy branches (allow / reject) and the fail-open warning
// path run without any network or OTel dependency.
type CheckDeps = { onCheckFailure?: (error: unknown) => void };
const isBreachedPassword = mock(async (_password: string, _deps?: CheckDeps) => false);
const warn = mock((_message: string, _ctx?: unknown) => {});
const addSpanEvent = mock((_name: string, _attrs?: unknown) => {});

mock.module("@hootifactory/auth", () => ({
  isBreachedPassword,
  BREACHED_PASSWORD_MESSAGE: "this password appears in known data breaches; choose a different one",
}));
mock.module("@hootifactory/observability", () => ({
  addSpanEvent,
  logger: { warn },
}));

const { breachedPasswordRejection } = await import("./auth-password-policy");

function appWithPolicy() {
  const app = new Hono<AppEnv>();
  app.post("/check", async (c) => {
    const rejection = await breachedPasswordRejection(c, "candidate-password");
    if (rejection) return rejection;
    return c.json({ ok: true });
  });
  return app;
}

function check(): Request {
  return new Request("http://localhost/check", { method: "POST" });
}

describe("breachedPasswordRejection", () => {
  beforeEach(() => {
    isBreachedPassword.mockClear();
    warn.mockClear();
    addSpanEvent.mockClear();
    isBreachedPassword.mockImplementation(async () => false);
  });

  test("returns null for passwords not found in breaches", async () => {
    const res = await appWithPolicy().fetch(check());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(isBreachedPassword).toHaveBeenCalledTimes(1);
    expect(isBreachedPassword.mock.calls[0]?.[0]).toBe("candidate-password");
  });

  test("rejects breached passwords with a 400 and a count-free message", async () => {
    isBreachedPassword.mockImplementation(async () => true);
    const res = await appWithPolicy().fetch(check());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "this password appears in known data breaches; choose a different one",
    });
  });

  test("logs a warning and allows the password when the upstream check fails", async () => {
    isBreachedPassword.mockImplementation(async (_password, deps) => {
      deps?.onCheckFailure?.(new Error("HIBP unreachable"));
      return false;
    });
    const res = await appWithPolicy().fetch(check());
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("fail-open");
  });
});
