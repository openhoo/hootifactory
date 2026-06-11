import { BREACHED_PASSWORD_MESSAGE, isBreachedPassword } from "@hootifactory/auth";
import { addSpanEvent, logger } from "@hootifactory/observability";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { errorMessage } from "../validation";

/**
 * Shared choke point for every route where a user chooses a password
 * (registration and password-reset confirmation). Runs the opt-in HIBP
 * k-anonymity check and returns a 400 rejection when the password is known
 * to be breached, or null when the password is acceptable.
 *
 * Fail-open by design: when the upstream check errors out we log a warning
 * and allow the password — a HIBP outage must never block signups.
 */
export async function breachedPasswordRejection(
  c: Context<AppEnv>,
  password: string,
): Promise<Response | null> {
  const breached = await isBreachedPassword(password, {
    onCheckFailure: (error) => {
      addSpanEvent("auth.breached_password_check_failed", {
        "error.message": errorMessage(error),
      });
      logger.warn("breached-password check failed; allowing password (fail-open)", {
        error,
      });
    },
  });
  if (!breached) return null;
  addSpanEvent("auth.password_breached");
  logger.warn("password rejected by breached-password check");
  return c.json({ error: BREACHED_PASSWORD_MESSAGE }, 400);
}
