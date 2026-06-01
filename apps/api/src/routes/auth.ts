import { createSession, hashPassword, revokeSession, writeAudit } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { isUniqueViolation, z } from "@hootifactory/core";
import { db, users } from "@hootifactory/db";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withSpan,
} from "@hootifactory/observability";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { authenticateUserPassword, SESSION_COOKIE } from "../middleware/authenticate";
import type { AppEnv } from "../types";
import { validateJsonBody } from "../validation";

export const authRouter = new Hono<AppEnv>();

interface LoginThrottleBucket {
  count: number;
  resetAt: number;
}

const loginFailures = new Map<string, LoginThrottleBucket>();

const RegisterBodySchema = z.strictObject({
  username: z.string().trim().min(1).max(128),
  email: z.email().max(320),
  password: z.string().min(8).max(1024),
  displayName: z.string().trim().min(1).max(256).optional(),
});

const LoginBodySchema = z.strictObject({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown"
  );
}

function loginThrottleKey(username: string, ip: string): string {
  return `${username.trim().toLowerCase()}\0${ip}`;
}

function currentLoginBucket(key: string, now = Date.now()): LoginThrottleBucket {
  const existing = loginFailures.get(key);
  if (existing && existing.resetAt > now) return existing;
  const fresh = {
    count: 0,
    resetAt: now + env.AUTH_LOGIN_WINDOW_SECONDS * 1000,
  };
  loginFailures.set(key, fresh);
  return fresh;
}

function retryAfterSeconds(bucket: LoginThrottleBucket, now = Date.now()): number {
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

function loginIsThrottled(
  key: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const bucket = currentLoginBucket(key);
  if (bucket.count < env.AUTH_LOGIN_MAX_ATTEMPTS) return { throttled: false };
  return { throttled: true, retryAfter: retryAfterSeconds(bucket) };
}

function recordLoginFailure(key: string): LoginThrottleBucket {
  const bucket = currentLoginBucket(key);
  bucket.count += 1;
  return bucket;
}

function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

authRouter.post("/register", async (c) => {
  if (!env.AUTH_ALLOW_REGISTRATION) {
    addSpanEvent("auth.registration_disabled");
    logger.warn("registration rejected because it is disabled");
    return c.json({ error: "registration is disabled" }, 403);
  }

  const parsedBody = await validateJsonBody(c, RegisterBodySchema, "invalid registration request");
  if (!parsedBody.ok) {
    addSpanEvent("auth.registration_invalid_request");
    return parsedBody.response;
  }
  const body = parsedBody.data;
  const username = body.username;
  const email = body.email;
  const password = body.password;
  const displayName = body.displayName ?? username;
  try {
    const [user] = await withSpan("auth.register_user", {}, async () =>
      db
        .insert(users)
        .values({
          username,
          email,
          displayName,
          passwordHash: await hashPassword(password),
        })
        .returning(),
    );
    if (!user) return c.json({ error: "failed to create user" }, 500);
    const { secret, expiresAt } = await createSession(user.id, {
      ip: c.req.header("x-forwarded-for") ?? undefined,
    });
    setCookie(c, SESSION_COOKIE, secret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: env.NODE_ENV === "production",
      expires: expiresAt,
    });
    setActiveSpanAttributes({ "enduser.id": user.id, "auth.event": "registration" });
    logger.info("user registered", { userId: user.id });
    return c.json({ user: { id: user.id, username: user.username, email: user.email } }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      addSpanEvent("auth.registration_conflict");
      logger.warn("registration rejected for duplicate username or email");
      return c.json({ error: "username or email already taken" }, 409);
    }
    throw err;
  }
});

authRouter.post("/login", async (c) => {
  const parsedBody = await validateJsonBody(c, LoginBodySchema, "invalid login request");
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const username = body.username;
  const password = body.password;
  const ip = clientIp(c);
  const throttleKey = loginThrottleKey(username, ip);
  const throttle = loginIsThrottled(throttleKey);
  if (throttle.throttled) {
    addSpanEvent("auth.login_rate_limited", { "auth.retry_after_seconds": throttle.retryAfter });
    logger.warn("login rejected by throttle", { ip, retryAfter: throttle.retryAfter });
    void writeAudit({
      action: "auth.login",
      result: "failure",
      ip,
      detail: { username, reason: "rate_limited" },
    }).catch(() => {});
    return c.json({ error: "too many login attempts, try again later" }, 429, {
      "retry-after": String(throttle.retryAfter),
    });
  }
  const principal = await withSpan("auth.verify_password", {}, () =>
    authenticateUserPassword(username, password),
  );
  if (principal?.kind !== "user") {
    const failure = recordLoginFailure(throttleKey);
    addSpanEvent("auth.login_failed", { "auth.failed_attempts": failure.count });
    logger.warn("login failed", { ip, attempts: failure.count });
    void writeAudit({
      action: "auth.login",
      result: "failure",
      ip,
      detail: {
        username,
        attempts: failure.count,
        resetAt: new Date(failure.resetAt).toISOString(),
      },
    }).catch(() => {});
    return c.json({ error: "invalid credentials" }, 401);
  }
  clearLoginFailures(throttleKey);
  setActiveSpanAttributes({ "enduser.id": principal.userId, "auth.event": "login" });
  logger.info("login succeeded", { userId: principal.userId, ip });
  void writeAudit({
    action: "auth.login",
    result: "success",
    ip,
    principal,
    resourceType: "user",
    resourceId: principal.userId,
  }).catch(() => {});
  const { secret, expiresAt } = await createSession(principal.userId, {
    ip: c.req.header("x-forwarded-for") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  });
  setCookie(c, SESSION_COOKIE, secret, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
  });
  return c.json({ user: { id: principal.userId, username: principal.username } });
});

authRouter.post("/logout", async (c) => {
  const secret = getCookie(c, SESSION_COOKIE);
  if (secret) {
    await withSpan("auth.revoke_session", {}, () => revokeSession(secret));
    logger.info("session revoked");
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRouter.get("/me", (c) => {
  const p = c.get("principal");
  if (p.kind === "anonymous") return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, principal: p });
});
