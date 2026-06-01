import type { OidcProviderConfig } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import type { EmailJob } from "@hootifactory/email";
import { captureTelemetryContext } from "@hootifactory/observability";
import { enqueue, QUEUES } from "@hootifactory/queue";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../middleware/authenticate";
import type { AppEnv } from "../types";

const OIDC_STATE_COOKIE = "hoot_oidc_state";

export function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown"
  );
}

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
  const url = new URL(c.req.url);
  const host = forwardedValue(c, "x-forwarded-host");
  if (host) {
    url.host = host;
    url.protocol = `${forwardedValue(c, "x-forwarded-proto") ?? url.protocol.replace(":", "")}:`;
  }
  return url;
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

export async function enqueueEmail(job: EmailJob): Promise<void> {
  if (!env.EMAIL_ENABLED) return;
  await enqueue(
    QUEUES.emailSend,
    { ...job, telemetry: captureTelemetryContext() },
    {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: job.deliveryKey,
      singletonSeconds: job.deliveryKey ? 7 * 24 * 60 * 60 : undefined,
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

export function deleteSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function forwardedValue(c: Context<AppEnv>, header: string): string | undefined {
  return c.req.header(header)?.split(",")[0]?.trim() || undefined;
}
