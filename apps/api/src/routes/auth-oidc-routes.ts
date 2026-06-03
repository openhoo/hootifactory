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
import { addSpanEvent, logger, setActiveSpanAttributes } from "@hootifactory/observability";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { errorMessage } from "../validation";
import {
  browserFacingUrl,
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
import { ConfirmLinkQuerySchema, OidcLinkMetadataSchema } from "./auth-schemas";
import { audit } from "./http";

function oidcAuditDetail(claims: { issuer: string; subject: string }) {
  return { issuer: claims.issuer, subject: claims.subject };
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

  router.get("/oidc/link/confirm", async (c) => {
    const parsedQuery = ConfirmLinkQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) return c.redirect(loginRedirect("sso_link_invalid"));

    const token = await consumeAuthEmailToken("oidc_link", parsedQuery.data.token);
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
  });
}
