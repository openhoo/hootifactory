import { findPasswordResetUser, resetPasswordWithToken } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { addSpanEvent, logger } from "@hootifactory/observability";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { errorMessage, validateJsonBody } from "../validation";
import { clientIp, enqueueEmail, publicUrl } from "./auth-helpers";
import { createPasswordResetEmail } from "./auth-password-reset";
import { PasswordResetConfirmBodySchema, PasswordResetRequestBodySchema } from "./auth-schemas";
import {
  passwordResetIsThrottled,
  passwordResetThrottleKey,
  recordPasswordResetRequest,
} from "./auth-throttle";
import { audit } from "./http";

export function registerPasswordResetRoutes(router: Hono<AppEnv>): void {
  router.post("/password-reset/request", async (c) => {
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

    const user = await findPasswordResetUser(email);
    if (user) {
      try {
        const { job } = await createPasswordResetEmail({
          userId: user.id,
          email: user.email,
          ttlSeconds: env.AUTH_PASSWORD_RESET_TTL_SECONDS,
          publicUrl,
        });
        await enqueueEmail(job);
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
        logger.error("password reset email failed", { userId: user.id, error: err });
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

  router.post("/password-reset/confirm", async (c) => {
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
}
