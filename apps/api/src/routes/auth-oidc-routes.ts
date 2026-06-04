import { timingSafeEqual } from "node:crypto";
import {
  consumeAuthEmailToken,
  createOidcAuthorizationRequest,
  OidcEmailLinkRequiredError,
  oidcIdentityBelongsToAnotherUser,
  resolveOidcCallbackClaims,
  safeOidcReturnTo,
  signOidcState,
  syncOidcUser,
  verifyOidcState,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { parseJsonWithSchema, z } from "@hootifactory/core";
import { addSpanEvent, logger, setActiveSpanAttributes } from "@hootifactory/observability";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { errorMessage } from "../validation";
import {
  browserFacingUrl,
  clientIp,
  createRequestSession,
  deleteOidcStateCookie,
  enqueueEmail,
  loginNoticeRedirect,
  loginRedirect,
  oidcCallbackUrl,
  oidcConfig,
  publicUrl,
  readOidcStateCookie,
  setOidcStateCookie,
} from "./auth-helpers";
import { createOidcLinkEmail } from "./auth-oidc-link";
import {
  ConfirmLinkBodySchema,
  ConfirmLinkQuerySchema,
  OidcLinkMetadataSchema,
} from "./auth-schemas";
import { consumeOidcLinkEmailRequest } from "./auth-throttle";
import { audit } from "./http";

const OIDC_LINK_CSRF_COOKIE = "hoot_oidc_link_confirm";
const OIDC_LINK_CSRF_TTL_MS = 10 * 60 * 1000;

const OidcLinkCsrfPayloadSchema = z.strictObject({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  csrf: z.string().min(1).max(512),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function oidcAuditDetail(claims: { issuer: string; subject: string }) {
  return { issuer: claims.issuer, subject: claims.subject };
}

function hmacHex(secret: string, body: string): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return h.digest("hex");
}

function sha256Hex(value: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(value);
  return h.digest("hex");
}

function randomBase64Url(byteLength = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLength))).toString("base64url");
}

function signOidcLinkCsrf(input: { token: string; csrf: string; expiresAt: number }): string {
  const body = Buffer.from(
    JSON.stringify({
      tokenHash: sha256Hex(input.token),
      csrf: input.csrf,
      expiresAt: input.expiresAt,
    }),
  ).toString("base64url");
  return `${body}.${hmacHex(env.SESSION_SECRET, body)}`;
}

function safeEquals(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyOidcLinkCsrf(
  value: string | undefined,
  input: { token: string; csrf: string },
  now = Date.now(),
): boolean {
  const [body, sig, extra] = value?.split(".") ?? [];
  if (!body || !sig || extra !== undefined) return false;
  if (!safeEquals(sig, hmacHex(env.SESSION_SECRET, body))) return false;

  const payload = parseJsonWithSchema(
    OidcLinkCsrfPayloadSchema,
    Buffer.from(body, "base64url").toString("utf8"),
  );
  if (!payload) return false;
  return (
    payload.expiresAt >= now &&
    payload.tokenHash === sha256Hex(input.token) &&
    safeEquals(payload.csrf, input.csrf)
  );
}

function setOidcLinkCsrfCookie(c: Context<AppEnv>, token: string, csrf: string): void {
  const expiresAt = Date.now() + OIDC_LINK_CSRF_TTL_MS;
  setCookie(c, OIDC_LINK_CSRF_COOKIE, signOidcLinkCsrf({ token, csrf, expiresAt }), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/api/auth/oidc/link/confirm",
    secure: env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
}

function deleteOidcLinkCsrfCookie(c: Context<AppEnv>): void {
  deleteCookie(c, OIDC_LINK_CSRF_COOKIE, { path: "/api/auth/oidc/link/confirm" });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderOidcLinkConfirmation(token: string, csrf: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Confirm SSO sign-in</title>",
    "<style>",
    "body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#171717}",
    "main{width:min(92vw,30rem);background:white;border:1px solid #ddd;border-radius:8px;padding:2rem;box-shadow:0 10px 30px #0001}",
    "h1{font-size:1.35rem;margin:0 0 1rem}",
    "p{line-height:1.5;margin:0 0 1.5rem;color:#444}",
    "button,a{font:inherit}",
    "button{border:0;border-radius:6px;background:#111;color:white;padding:.75rem 1rem;cursor:pointer}",
    "a{display:inline-block;margin-left:1rem;color:#444}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>Confirm SSO sign-in</h1>",
    "<p>Continue only if you just tried to sign in with SSO and want to link it to this Hootifactory account.</p>",
    '<form method="post" action="/api/auth/oidc/link/confirm">',
    `<input type="hidden" name="token" value="${escapeHtml(token)}">`,
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    '<button type="submit">Confirm sign-in</button>',
    '<a href="/login">Cancel</a>',
    "</form>",
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

async function parseConfirmLinkBody(c: Context<AppEnv>) {
  try {
    return ConfirmLinkBodySchema.safeParse(await c.req.parseBody());
  } catch {
    return ConfirmLinkBodySchema.safeParse(null);
  }
}

async function confirmOidcLink(c: Context<AppEnv>, tokenSecret: string): Promise<Response> {
  const token = await consumeAuthEmailToken("oidc_link", tokenSecret);
  if (!token) return c.redirect(loginRedirect("sso_link_invalid"));

  const metadata = OidcLinkMetadataSchema.safeParse(token.metadata);
  if (!metadata.success) return c.redirect(loginRedirect("sso_link_invalid"));
  const { claims, returnTo } = metadata.data;

  if (
    await oidcIdentityBelongsToAnotherUser({
      issuer: claims.issuer,
      subject: claims.subject,
      userId: token.userId,
    })
  ) {
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
}

export function registerOidcRoutes(router: Hono<AppEnv>): void {
  router.get("/oidc/start", async (c) => {
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

  router.get("/oidc/callback", async (c) => {
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
        const ip = clientIp(c);
        if (!env.EMAIL_ENABLED) {
          logger.warn("OIDC link confirmation required but email is disabled", {
            userId: err.userId,
          });
          return c.redirect(loginRedirect("sso_link_unavailable"));
        }
        const throttle = await consumeOidcLinkEmailRequest(err.email, ip);
        if (throttle.throttled) {
          addSpanEvent("auth.oidc_link_email_rate_limited", {
            "auth.retry_after_seconds": throttle.retryAfter,
          });
          logger.warn("OIDC link confirmation email rejected by throttle", {
            userId: err.userId,
            ip,
            retryAfter: throttle.retryAfter,
          });
          audit({
            action: "auth.oidc_link_email",
            result: "failure",
            resourceType: "user",
            resourceId: err.userId,
            ip,
            detail: { error: "rate_limited" },
          });
          c.header("retry-after", String(throttle.retryAfter));
          return c.redirect(loginRedirect("sso_link_limited"));
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
          ip,
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

  router.get("/oidc/link/confirm", async (c) => {
    const parsedQuery = ConfirmLinkQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) return c.redirect(loginRedirect("sso_link_invalid"));

    const csrf = randomBase64Url();
    setOidcLinkCsrfCookie(c, parsedQuery.data.token, csrf);
    return c.html(renderOidcLinkConfirmation(parsedQuery.data.token, csrf));
  });

  router.post("/oidc/link/confirm", async (c) => {
    const parsedBody = await parseConfirmLinkBody(c);
    if (!parsedBody.success) {
      deleteOidcLinkCsrfCookie(c);
      return c.redirect(loginRedirect("sso_link_invalid"));
    }

    const csrfCookie = getCookie(c, OIDC_LINK_CSRF_COOKIE);
    deleteOidcLinkCsrfCookie(c);
    if (
      !verifyOidcLinkCsrf(csrfCookie, {
        token: parsedBody.data.token,
        csrf: parsedBody.data.csrf,
      })
    ) {
      return c.redirect(loginRedirect("sso_link_invalid"));
    }

    return confirmOidcLink(c, parsedBody.data.token);
  });
}
