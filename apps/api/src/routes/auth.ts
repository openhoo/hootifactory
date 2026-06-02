import {
  consumeAuthEmailToken,
  createAuthEmailToken,
  createOidcAuthorizationRequest,
  hashPassword,
  OidcEmailLinkRequiredError,
  resetPasswordWithToken,
  resolveOidcCallbackClaims,
  revokeSession,
  safeOidcReturnTo,
  signOidcState,
  syncOidcUser,
  verifyOidcState,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { isUniqueViolation } from "@hootifactory/core";
import { and, db, eq, externalIdentities, users } from "@hootifactory/db";
import {
  addSpanEvent,
  logger,
  setActiveSpanAttributes,
  withSpan,
} from "@hootifactory/observability";
import { Hono } from "hono";
import { authenticateUserPassword } from "../middleware/authenticate";
import type { AppEnv } from "../types";
import { errorMessage, validateJsonBody } from "../validation";
import {
  browserFacingUrl,
  clientIp,
  createRequestSession,
  deleteOidcStateCookie,
  deleteSessionCookie,
  enqueueEmail,
  loginNoticeRedirect,
  loginRedirect,
  oidcCallbackUrl,
  oidcConfig,
  publicUrl,
  readOidcStateCookie,
  readSessionCookie,
  setOidcStateCookie,
} from "./auth-helpers";
import { createOidcLinkEmail } from "./auth-oidc-link";
import {
  ConfirmLinkQuerySchema,
  LoginBodySchema,
  OidcLinkMetadataSchema,
  PasswordResetConfirmBodySchema,
  PasswordResetRequestBodySchema,
  RegisterBodySchema,
} from "./auth-schemas";
import {
  clearLoginFailures,
  loginIsThrottled,
  loginThrottleKey,
  passwordResetIsThrottled,
  passwordResetThrottleKey,
  recordLoginFailure,
  recordPasswordResetRequest,
} from "./auth-throttle";
import { audit } from "./http";

export const authRouter = new Hono<AppEnv>();

function oidcAuditDetail(claims: { issuer: string; subject: string }) {
  return { issuer: claims.issuer, subject: claims.subject };
}

authRouter.get("/methods", (c) =>
  c.json({
    password: true,
    registration: env.AUTH_ALLOW_REGISTRATION,
    oidc: env.AUTH_OIDC_ENABLED
      ? {
          enabled: true,
          name: env.AUTH_OIDC_NAME,
          startUrl: "/api/auth/oidc/start",
        }
      : { enabled: false },
  }),
);

authRouter.get("/oidc/start", async (c) => {
  const config = oidcConfig();
  if (!config) return c.json({ error: "OIDC is not enabled" }, 404);
  const requestUrl = browserFacingUrl(c);
  const returnTo = safeOidcReturnTo(requestUrl.searchParams.get("returnTo"));
  const request = await createOidcAuthorizationRequest(config, oidcCallbackUrl(c), returnTo);
  setOidcStateCookie(
    c,
    signOidcState(request.state, env.SESSION_SECRET),
    new Date(request.state.expiresAt),
  );
  return c.redirect(request.url.href);
});

authRouter.get("/oidc/callback", async (c) => {
  const config = oidcConfig();
  if (!config) return c.redirect(loginRedirect("sso_disabled"));
  const state = verifyOidcState(readOidcStateCookie(c), env.SESSION_SECRET);
  deleteOidcStateCookie(c);
  if (!state) return c.redirect(loginRedirect("sso_state"));

  let claims: Awaited<ReturnType<typeof resolveOidcCallbackClaims>> | null = null;
  try {
    claims = await resolveOidcCallbackClaims(config, browserFacingUrl(c), state);
    const user = await syncOidcUser(claims);
    await createRequestSession(c, user.id);
    setActiveSpanAttributes({ "enduser.id": user.id, "auth.event": "oidc_login" });
    logger.info("OIDC login succeeded", { userId: user.id, issuer: claims.issuer });
    audit({
      action: "auth.oidc_login",
      result: "success",
      resourceType: "user",
      resourceId: user.id,
      detail: {
        issuer: claims.issuer,
        subject: claims.subject,
        groups: claims.groups,
        grants: claims.grants.map((grant) => ({ org: grant.org, role: grant.role })),
      },
    });
    return c.redirect(state.returnTo);
  } catch (err) {
    if (claims && err instanceof OidcEmailLinkRequiredError) {
      if (!env.EMAIL_ENABLED) {
        logger.warn("OIDC link confirmation required but email is disabled", {
          userId: err.userId,
        });
        return c.redirect(loginRedirect("sso_link_unavailable"));
      }
      const { job } = await createOidcLinkEmail({
        userId: err.userId,
        email: err.email,
        claims,
        returnTo: state.returnTo,
        ttlSeconds: env.AUTH_OIDC_LINK_TTL_SECONDS,
        providerName: env.AUTH_OIDC_NAME,
        publicUrl,
      });
      await enqueueEmail(job);
      addSpanEvent("auth.oidc_link_email_sent");
      logger.info("OIDC link confirmation email queued", { userId: err.userId });
      audit({
        action: "auth.oidc_link_email",
        result: "success",
        resourceType: "user",
        resourceId: err.userId,
        detail: oidcAuditDetail(claims),
      });
      return c.redirect(loginNoticeRedirect("sso_link_email"));
    }
    const message = errorMessage(err);
    addSpanEvent("auth.oidc_login_failed", { "auth.failure": message });
    logger.warn("OIDC login failed", { error: message });
    audit({
      action: "auth.oidc_login",
      result: "failure",
      detail: { error: message },
    });
    return c.redirect(loginRedirect());
  }
});

authRouter.get("/oidc/link/confirm", async (c) => {
  const parsedQuery = ConfirmLinkQuerySchema.safeParse(c.req.query());
  if (!parsedQuery.success) return c.redirect(loginRedirect("sso_link_invalid"));

  const token = await consumeAuthEmailToken("oidc_link", parsedQuery.data.token);
  if (!token) return c.redirect(loginRedirect("sso_link_invalid"));

  const metadata = OidcLinkMetadataSchema.safeParse(token.metadata);
  if (!metadata.success) return c.redirect(loginRedirect("sso_link_invalid"));
  const { claims, returnTo } = metadata.data;

  const [existingIdentity] = await db
    .select({ userId: externalIdentities.userId })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.provider, "oidc"),
        eq(externalIdentities.issuer, claims.issuer),
        eq(externalIdentities.subject, claims.subject),
      ),
    )
    .limit(1);
  if (existingIdentity && existingIdentity.userId !== token.userId) {
    return c.redirect(loginRedirect("sso_link_invalid"));
  }

  try {
    const user = await syncOidcUser(claims, { allowExistingEmailLink: true });
    if (user.id !== token.userId) return c.redirect(loginRedirect("sso_link_invalid"));
    await createRequestSession(c, user.id);
    setActiveSpanAttributes({ "enduser.id": user.id, "auth.event": "oidc_link_confirm" });
    logger.info("OIDC link confirmation succeeded", { userId: user.id, issuer: claims.issuer });
    audit({
      action: "auth.oidc_link_confirm",
      result: "success",
      resourceType: "user",
      resourceId: user.id,
      detail: oidcAuditDetail(claims),
    });
    return c.redirect(safeOidcReturnTo(returnTo));
  } catch (err) {
    const message = errorMessage(err);
    logger.warn("OIDC link confirmation failed", { error: message });
    audit({
      action: "auth.oidc_link_confirm",
      result: "failure",
      resourceType: "user",
      resourceId: token.userId,
      detail: { error: message },
    });
    return c.redirect(loginRedirect("sso_link_invalid"));
  }
});

authRouter.post("/password-reset/request", async (c) => {
  const parsedBody = await validateJsonBody(
    c,
    PasswordResetRequestBodySchema,
    "invalid password reset request",
  );
  if (!parsedBody.ok) return parsedBody.response;
  const { email } = parsedBody.data;
  const ip = clientIp(c);
  const throttleKey = passwordResetThrottleKey(email, ip);
  const throttle = passwordResetIsThrottled(throttleKey);
  if (throttle.throttled) {
    addSpanEvent("auth.password_reset_rate_limited", {
      "auth.retry_after_seconds": throttle.retryAfter,
    });
    logger.warn("password reset request rejected by throttle", {
      ip,
      retryAfter: throttle.retryAfter,
    });
    return c.json({ error: "too many password reset requests, try again later" }, 429, {
      "retry-after": String(throttle.retryAfter),
    });
  }
  recordPasswordResetRequest(throttleKey);

  if (!env.EMAIL_ENABLED) {
    logger.debug("password reset request ignored because email is disabled");
    return c.json({ ok: true });
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (user?.isActive && user.passwordHash) {
    try {
      const { token, secret } = await createAuthEmailToken({
        purpose: "password_reset",
        userId: user.id,
        email: user.email,
        ttlSeconds: env.AUTH_PASSWORD_RESET_TTL_SECONDS,
      });
      await enqueueEmail({
        template: "password_reset",
        to: user.email,
        resetUrl: publicUrl(`/reset-password?token=${encodeURIComponent(secret)}`),
        expiresAt: token.expiresAt.toISOString(),
        deliveryKey: `password-reset-${token.id}`,
      });
      logger.info("password reset email queued", { userId: user.id });
      audit({
        action: "auth.password_reset_email",
        result: "success",
        resourceType: "user",
        resourceId: user.id,
        ip,
      });
    } catch (err) {
      const message = errorMessage(err);
      addSpanEvent("auth.password_reset_email_failed", { "error.message": message });
      logger.error("password reset email failed", { error: message });
      audit({
        action: "auth.password_reset_email",
        result: "failure",
        resourceType: "user",
        resourceId: user.id,
        ip,
        detail: { error: message },
      });
    }
  }

  return c.json({ ok: true });
});

authRouter.post("/password-reset/confirm", async (c) => {
  const parsedBody = await validateJsonBody(
    c,
    PasswordResetConfirmBodySchema,
    "invalid password reset confirmation",
  );
  if (!parsedBody.ok) return parsedBody.response;
  const reset = await resetPasswordWithToken(parsedBody.data.token, parsedBody.data.password);
  if (!reset) return c.json({ error: "invalid or expired reset token" }, 400);
  logger.info("password reset confirmed", { userId: reset.userId });
  audit({
    action: "auth.password_reset_confirm",
    result: "success",
    resourceType: "user",
    resourceId: reset.userId,
    ip: clientIp(c),
  });
  return c.json({ ok: true });
});

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

authRouter.post("/logout", async (c) => {
  const secret = readSessionCookie(c);
  if (secret) {
    await withSpan("auth.revoke_session", {}, () => revokeSession(secret));
    logger.info("session revoked");
  }
  deleteSessionCookie(c);
  return c.json({ ok: true });
});

authRouter.get("/me", (c) => {
  const p = c.get("principal");
  if (p.kind === "anonymous") return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, principal: p });
});
