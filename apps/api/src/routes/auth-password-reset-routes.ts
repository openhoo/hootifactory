import {
  dummyPasswordResetWork,
  findPasswordResetUser,
  resetPasswordWithToken,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { addSpanEvent, logger } from "@hootifactory/observability";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { errorMessage, validateJsonBody } from "../validation";
import { clientIp, enqueueEmail, publicUrl } from "./auth-helpers";
import { breachedPasswordRejection } from "./auth-password-policy";
import { createPasswordResetEmail } from "./auth-password-reset";
import { PasswordResetConfirmBodySchema, PasswordResetRequestBodySchema } from "./auth-schemas";
import { consumePasswordResetRequest } from "./auth-throttle";
import { AUDIT_RESULT, audit } from "./http";

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
    const throttle = await consumePasswordResetRequest(email, ip);
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
        audit(c, {
          action: "auth.password_reset_email",
          result: AUDIT_RESULT.success,
          resourceType: "user",
          resourceId: user.id,
          ip,
        });
      } catch (err) {
        const message = errorMessage(err);
        addSpanEvent("auth.password_reset_email_failed", { "error.message": message });
        logger.error("password reset email failed", { userId: user.id, error: err });
        audit(c, {
          action: "auth.password_reset_email",
          result: AUDIT_RESULT.failure,
          resourceType: "user",
          resourceId: user.id,
          ip,
          detail: { error: message },
        });
      }
    } else {
      // Normalize response latency so unknown/inactive emails cost the same as
      // real ones, preventing account-existence enumeration via timing. We never
      // send mail or persist a token here — only equivalent throwaway work.
      // Swallow failures like the user branch does, so a transient DB error
      // can't make the no-user path return a 500 and re-open the side channel.
      try {
        await dummyPasswordResetWork();
      } catch (err) {
        const message = errorMessage(err);
        addSpanEvent("auth.password_reset_dummy_failed", { "error.message": message });
        logger.error("password reset dummy work failed", { error: err });
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
    // Checked before the token is consumed so a rejected password leaves the
    // reset token valid for another attempt.
    const breachedRejection = await breachedPasswordRejection(c, parsedBody.data.password);
    if (breachedRejection) {
      logger.warn("password reset confirmation rejected for breached password");
      return breachedRejection;
    }
    const reset = await resetPasswordWithToken(parsedBody.data.token, parsedBody.data.password);
    if (!reset) return c.json({ error: "invalid or expired reset token" }, 400);
    logger.info("password reset confirmed", { userId: reset.userId });
    audit(c, {
      action: "auth.password_reset_confirm",
      result: AUDIT_RESULT.success,
      resourceType: "user",
      resourceId: reset.userId,
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  });
}
