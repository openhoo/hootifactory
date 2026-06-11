import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loadEnv } from "@hootifactory/config";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Cover the DB/queue-backed helpers: createRequestSession (createSession) and the
// enabled branch of enqueueEmail (enqueue). Both deps are stubbed.
const createSession = mock(
  async (_userId: string, _opts?: { ip?: string; userAgent?: string }) => ({
    secret: "session-secret",
    expiresAt: new Date(Date.now() + 60_000),
  }),
);
const enqueue = mock(async () => {});
const captureTelemetryContext = mock(() => ({ traceId: "t" }));

const env = { ...loadEnv(), EMAIL_ENABLED: true };

mock.module("@hootifactory/config", () => ({ env, loadEnv }));
mock.module("@hootifactory/auth", () => ({
  createSession,
  // Present so middleware/authenticate + auth-throttle (transitively in the
  // graph via SESSION_COOKIE) link without re-implementing the auth surface.
  TOKEN_PREFIX: "hoot_",
  REGISTRY_TOKEN_SERVICE: "hootifactory",
  resolveSession: async () => null,
  resolveToken: async () => null,
  userPrincipalById: async () => null,
  verifyRegistryToken: async () => {
    throw new Error("invalid");
  },
  authenticateUserPassword: async () => null,
  clearSharedAuthThrottleBucket: async () => {},
  consumeSharedAuthThrottleBucket: async () => ({
    throttled: false,
    bucket: { count: 0, resetAt: 0 },
  }),
}));
mock.module("@hootifactory/queue", () => ({ enqueue, QUEUES: { emailSend: "email.send" } }));
mock.module("@hootifactory/observability", () => ({
  captureTelemetryContext,
  // Present so sibling modules in the graph (e.g. middleware/authenticate) link.
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  withSpan: async (_name: string, _attrs: unknown, fn: (span: unknown) => unknown) =>
    fn({ setAttribute() {}, setAttributes() {}, addEvent() {} }),
  addSpanEvent() {},
  setActiveSpanAttributes() {},
}));

const { createRequestSession, enqueueEmail } = await import("./auth-helpers");

async function runRoute(handler: (c: Context<AppEnv>) => Promise<void>, init?: RequestInit) {
  const app = new Hono<AppEnv>();
  app.get("/probe", async (c) => {
    await handler(c);
    return c.json({ ok: true });
  });
  return app.fetch(new Request("http://localhost/probe", init));
}

describe("auth helper session + queue integration", () => {
  beforeEach(() => {
    createSession.mockClear();
    enqueue.mockClear();
    env.EMAIL_ENABLED = true;
  });

  test("createRequestSession mints a session and sets the cookie", async () => {
    const res = await runRoute((c) => createRequestSession(c, "user_1"), {
      headers: { "user-agent": "test-agent" },
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(res.headers.get("set-cookie")).toContain("hoot_session=session-secret");
  });

  test("createRequestSession can omit the user agent", async () => {
    await runRoute((c) => createRequestSession(c, "user_1", { includeUserAgent: false }), {
      headers: { "user-agent": "test-agent" },
    });
    const call = createSession.mock.calls[0]?.[1] as { userAgent?: string } | undefined;
    expect(call?.userAgent).toBeUndefined();
  });

  test("enqueueEmail enqueues the job when email is enabled", async () => {
    await enqueueEmail({
      template: "password_reset",
      to: "user@example.test",
      deliveryKey: "k",
    } as never);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test("enqueueEmail skips queuing when email is disabled", async () => {
    env.EMAIL_ENABLED = false;
    await enqueueEmail({ template: "password_reset", to: "user@example.test" } as never);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
