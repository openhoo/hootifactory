import { createSession, type OidcProviderConfig } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import type { EmailJob } from "@hootifactory/email";
import { captureTelemetryContext } from "@hootifactory/observability";
import { enqueue, QUEUES } from "@hootifactory/queue";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../middleware/authenticate";
import { clientIpOrUndefined } from "../request-ip";
import type { AppEnv } from "../types";

const OIDC_STATE_COOKIE = "hoot_oidc_state";

export { clientIp } from "../request-ip";

export function oidcConfig(): OidcProviderConfig | null {
  if (!env.AUTH_OIDC_ENABLED) return null;
  if (!env.AUTH_OIDC_ISSUER || !env.AUTH_OIDC_CLIENT_ID || !env.AUTH_OIDC_CLIENT_SECRET) {
    return null;
  }
  return {
    issuer: env.AUTH_OIDC_ISSUER,
    clientId: env.AUTH_OIDC_CLIENT_ID,
    clientSecret: env.AUTH_OIDC_CLIENT_SECRET,
    scopes: env.AUTH_OIDC_SCOPES,
    groupClaim: env.AUTH_OIDC_GROUP_CLAIM,
    groupMappings: env.AUTH_OIDC_GROUP_MAPPINGS,
    emailClaim: env.AUTH_OIDC_EMAIL_CLAIM,
    usernameClaim: env.AUTH_OIDC_USERNAME_CLAIM,
  };
}

export function browserFacingUrl(c: Context<AppEnv>): URL {
  const requestUrl = new URL(c.req.url);
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, `${env.APP_PUBLIC_URL}/`);
}

export function oidcCallbackUrl(c: Context<AppEnv>): string {
  const url = browserFacingUrl(c);
  url.pathname = "/api/auth/oidc/callback";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function loginRedirect(error = "sso_failed"): string {
  return `/login?error=${encodeURIComponent(error)}`;
}

export function loginNoticeRedirect(notice: string): string {
  return `/login?notice=${encodeURIComponent(notice)}`;
}

export function publicUrl(path: string): string {
  return new URL(path, `${env.APP_PUBLIC_URL}/`).href;
}

/**
 * Enqueue an email job. `deliveryKey` (mandatory on {@link EmailJob}) doubles
 * as the pg-boss singleton key, so the same logical email is queued at most
 * once per week even across API retries. The retry schedule must reach past
 * the mail worker's 15-minute claim-takeover threshold with attempts to spare:
 * a worker that crashes between claiming a delivery and confirming the SMTP
 * send leaves a claim that only becomes re-claimable after that threshold, so
 * later retries are what rescue the email. With backoff capped at 10 minutes,
 * attempts land around 0.5/1.5/3.5/7.5/15.5/25.5/35.5/45.5 minutes — the last
 * four all fall after the takeover window opens.
 */
export async function enqueueEmail(job: EmailJob): Promise<void> {
  if (!env.EMAIL_ENABLED) return;
  await enqueue(
    QUEUES.emailSend,
    { ...job, telemetry: captureTelemetryContext() },
    {
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 10 * 60,
      singletonKey: job.deliveryKey,
      singletonSeconds: 7 * 24 * 60 * 60,
    },
  );
}

export function readOidcStateCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, OIDC_STATE_COOKIE);
}

export function setOidcStateCookie(c: Context<AppEnv>, value: string, expiresAt: Date): void {
  setCookie(c, OIDC_STATE_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/api/auth/oidc",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export function deleteOidcStateCookie(c: Context<AppEnv>): void {
  deleteCookie(c, OIDC_STATE_COOKIE, { path: "/api/auth/oidc" });
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: Context<AppEnv>, secret: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, secret, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function createRequestSession(
  c: Context<AppEnv>,
  userId: string,
  options: { includeUserAgent?: boolean } = {},
): Promise<void> {
  const { secret, expiresAt } = await createSession(userId, {
    ip: clientIpOrUndefined(c),
    userAgent:
      options.includeUserAgent === false ? undefined : (c.req.header("user-agent") ?? undefined),
  });
  setSessionCookie(c, secret, expiresAt);
}

export function deleteSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
