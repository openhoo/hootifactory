import { hashPassword, revokeSession } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { isUniqueViolation } from "@hootifactory/core";
import { db, users } from "@hootifactory/db";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withSpan,
} from "@hootifactory/observability";
import type { Hono } from "hono";
import { authenticateUserPassword } from "../middleware/authenticate";
import type { AppEnv } from "../types";
import { validateJsonBody } from "../validation";
import {
  clientIp,
  createRequestSession,
  deleteSessionCookie,
  readSessionCookie,
} from "./auth-helpers";
import { LoginBodySchema, RegisterBodySchema } from "./auth-schemas";
import {
  clearLoginFailures,
  loginIsThrottled,
  loginThrottleKey,
  recordLoginFailure,
} from "./auth-throttle";
import { audit } from "./http";

export function registerLocalAuthRoutes(router: Hono<AppEnv>): void {
  router.post("/register", async (c) => {
    if (!env.AUTH_ALLOW_REGISTRATION) {
      addSpanEvent("auth.registration_disabled");
      logger.warn("registration rejected because it is disabled");
      return c.json({ error: "registration is disabled" }, 403);
    }

    const parsedBody = await validateJsonBody(
      c,
      RegisterBodySchema,
      "invalid registration request",
    );
    if (!parsedBody.ok) {
      addSpanEvent("auth.registration_invalid_request");
      return parsedBody.response;
    }
    const body = parsedBody.data;
    const username = body.username;
    const email = body.email;
    const password = body.password;
    const displayName = body.displayName;
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
      await createRequestSession(c, user.id, { includeUserAgent: false });
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

  router.post("/login", async (c) => {
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
      audit({
        action: "auth.login",
        result: "failure",
        ip,
        detail: { username, reason: "rate_limited" },
      });
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
      audit({
        action: "auth.login",
        result: "failure",
        ip,
        detail: {
          username,
          attempts: failure.count,
          resetAt: new Date(failure.resetAt).toISOString(),
        },
      });
      return c.json({ error: "invalid credentials" }, 401);
    }
    clearLoginFailures(throttleKey);
    setActiveSpanAttributes({ "enduser.id": principal.userId, "auth.event": "login" });
    logger.info("login succeeded", { userId: principal.userId, ip });
    audit({
      action: "auth.login",
      result: "success",
      ip,
      principal,
      resourceType: "user",
      resourceId: principal.userId,
    });
    await createRequestSession(c, principal.userId);
    return c.json({ user: { id: principal.userId, username: principal.username } });
  });

  router.post("/logout", async (c) => {
    const secret = readSessionCookie(c);
    if (secret) {
      await withSpan("auth.revoke_session", {}, () => revokeSession(secret));
      logger.info("session revoked");
    }
    deleteSessionCookie(c);
    return c.json({ ok: true });
  });

  router.get("/me", (c) => {
    const p = c.get("principal");
    if (p.kind === "anonymous") return c.json({ authenticated: false }, 401);
    return c.json({ authenticated: true, principal: p });
  });
}
