import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loadEnv } from "@hootifactory/config";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Drives the OIDC routes with mocked auth + auth-helpers so start/callback/link
// flows run without an IdP, DB, queue, or email. The CSRF helpers in the module
// under test are real (pure crypto) and exercised via the link/confirm flow.
type Claims = {
  issuer: string;
  subject: string;
  groups: string[];
  grants: Array<{ org: string; role: string }>;
};
const sampleClaims: Claims = {
  issuer: "https://idp.test",
  subject: "sub-1",
  groups: [],
  grants: [],
};

let oidcEnabled = true;
let callbackState: { returnTo: string; expiresAt: number } | null = {
  returnTo: "/dashboard",
  expiresAt: Date.now() + 60_000,
};

const createOidcAuthorizationRequest = mock(async () => ({
  url: new URL("https://idp.test/authorize?x=1"),
  state: { expiresAt: Date.now() + 60_000 },
}));
const resolveOidcCallbackClaims = mock(async () => sampleClaims);
const syncOidcUser = mock(async () => ({ id: "user_1" }));
const consumeAuthEmailToken = mock(
  async () => null as { userId: string; metadata: unknown } | null,
);
const oidcIdentityBelongsToAnotherUser = mock(async () => false);
const createRequestSession = mock(async () => {});
const createOidcLinkEmail = mock(async () => ({
  job: { template: "oidc_link", to: "u@e.test", deliveryKey: "k" },
}));
const enqueueEmail = mock(async () => {});
const consumeOidcLinkEmailRequest = mock(
  async () =>
    ({ throttled: false, bucket: { count: 0, resetAt: 0 } }) as
      | { throttled: false; bucket: { count: number; resetAt: number } }
      | { throttled: true; retryAfter: number },
);

class OidcEmailLinkRequiredError extends Error {
  userId = "user_1";
  email = "u@e.test";
}

const env = {
  ...loadEnv(),
  EMAIL_ENABLED: true,
  SESSION_SECRET: "test-secret-please-ignore-32chars",
};

mock.module("@hootifactory/config", () => ({ env, loadEnv }));
mock.module("@hootifactory/auth", () => ({
  consumeAuthEmailToken,
  createOidcAuthorizationRequest,
  OidcEmailLinkRequiredError,
  oidcIdentityBelongsToAnotherUser,
  resolveOidcCallbackClaims,
  safeOidcReturnTo: (value: string | null | undefined) => value ?? "/",
  signOidcState: (state: unknown) => JSON.stringify(state),
  syncOidcUser,
  verifyOidcState: () => callbackState,
}));
mock.module("./auth-helpers", () => ({
  oidcConfig: () => (oidcEnabled ? { issuer: "https://idp.test" } : null),
  browserFacingUrl: (c: { req: { url: string } }) => new URL(c.req.url),
  oidcCallbackUrl: () => "https://app.example.test/api/auth/oidc/callback",
  clientIp: () => "203.0.113.7",
  createRequestSession,
  deleteOidcStateCookie: () => {},
  enqueueEmail,
  loginNoticeRedirect: (notice: string) => `/login?notice=${notice}`,
  loginRedirect: (error = "sso_failed") => `/login?error=${error}`,
  publicUrl: (path: string) => `https://app.example.test${path}`,
  readOidcStateCookie: () => "state-cookie",
  setOidcStateCookie: () => {},
}));
mock.module("./auth-oidc-link", () => ({ createOidcLinkEmail }));
mock.module("./auth-throttle", () => ({ consumeOidcLinkEmailRequest }));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
}));

const { registerOidcRoutes } = await import("./auth-oidc-routes");

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", { kind: "anonymous" });
    await next();
  });
  registerOidcRoutes(router);
  return router;
}

const VALID_TOKEN = "abcdefabcdefabcdef";

describe("oidc routes", () => {
  beforeEach(() => {
    oidcEnabled = true;
    env.EMAIL_ENABLED = true;
    callbackState = { returnTo: "/dashboard", expiresAt: Date.now() + 60_000 };
    for (const m of [
      createOidcAuthorizationRequest,
      resolveOidcCallbackClaims,
      syncOidcUser,
      consumeAuthEmailToken,
      oidcIdentityBelongsToAnotherUser,
      createRequestSession,
      createOidcLinkEmail,
      enqueueEmail,
      consumeOidcLinkEmailRequest,
    ]) {
      m.mockClear();
    }
  });

  test("GET /oidc/start returns 404 when OIDC is disabled", async () => {
    oidcEnabled = false;
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/start"));
    expect(res.status).toBe(404);
  });

  test("GET /oidc/start redirects to the IdP authorization URL", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/start?returnTo=/x"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://idp.test/authorize?x=1");
  });

  test("GET /oidc/callback redirects to login when OIDC is disabled", async () => {
    oidcEnabled = false;
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_disabled");
  });

  test("GET /oidc/callback redirects when the state cookie is missing/invalid", async () => {
    callbackState = null;
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_state");
  });

  test("GET /oidc/callback logs in and redirects to returnTo on success", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(createRequestSession).toHaveBeenCalledTimes(1);
  });

  test("GET /oidc/callback redirects to a generic error on failure", async () => {
    resolveOidcCallbackClaims.mockRejectedValueOnce(new Error("token exchange failed"));
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=");
  });

  test("GET /oidc/callback queues a link-confirmation email when linking is required", async () => {
    syncOidcUser.mockRejectedValueOnce(new OidcEmailLinkRequiredError("link required"));
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_email");
    expect(createOidcLinkEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });

  test("GET /oidc/callback reports when linking is required but email is disabled", async () => {
    env.EMAIL_ENABLED = false;
    syncOidcUser.mockRejectedValueOnce(new OidcEmailLinkRequiredError("link required"));
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_unavailable");
  });

  test("GET /oidc/callback rate-limits link-confirmation emails", async () => {
    syncOidcUser.mockRejectedValueOnce(new OidcEmailLinkRequiredError("link required"));
    consumeOidcLinkEmailRequest.mockResolvedValueOnce({ throttled: true, retryAfter: 60 });
    const res = await appWithRoutes().fetch(new Request("http://localhost/oidc/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_limited");
  });

  test("GET /oidc/link/confirm renders the confirmation page and sets a CSRF cookie", async () => {
    const res = await appWithRoutes().fetch(
      new Request(`http://localhost/oidc/link/confirm?token=${VALID_TOKEN}`),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Confirm SSO sign-in");
    expect(res.headers.get("set-cookie")).toContain("hoot_oidc_link_confirm=");
  });

  test("GET /oidc/link/confirm redirects on an invalid token query", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/oidc/link/confirm?token=x"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_invalid");
  });

  test("POST /oidc/link/confirm completes a CSRF round-trip and confirms a valid token", async () => {
    const metadataClaims = {
      issuer: "https://idp.test",
      subject: "sub-1",
      email: "u@e.test",
      emailVerified: true,
      username: "alice",
      displayName: "Alice",
      groups: [],
      grants: [],
    };
    consumeAuthEmailToken.mockResolvedValueOnce({
      userId: "user_1",
      metadata: { claims: metadataClaims, returnTo: "/dashboard" },
    });
    syncOidcUser.mockResolvedValueOnce({ id: "user_1" });

    const app = appWithRoutes();
    // 1. GET to mint the CSRF cookie and read the csrf value from the form.
    const page = await app.fetch(
      new Request(`http://localhost/oidc/link/confirm?token=${VALID_TOKEN}`),
    );
    const setCookie = page.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csrf).not.toBe("");

    // 2. POST with the matching cookie + csrf.
    const res = await app.fetch(
      new Request("http://localhost/oidc/link/confirm", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ token: VALID_TOKEN, csrf }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");
    expect(createRequestSession).toHaveBeenCalledTimes(1);
  });

  test("POST /oidc/link/confirm redirects when the token cannot be consumed", async () => {
    consumeAuthEmailToken.mockResolvedValueOnce(null);
    const app = appWithRoutes();
    const page = await app.fetch(
      new Request(`http://localhost/oidc/link/confirm?token=${VALID_TOKEN}`),
    );
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";

    const res = await app.fetch(
      new Request("http://localhost/oidc/link/confirm", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ token: VALID_TOKEN, csrf }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_invalid");
  });

  test("POST /oidc/link/confirm redirects when the CSRF cookie is missing", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/oidc/link/confirm", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: VALID_TOKEN, csrf: "csrfcsrfcsrfcsrf" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_invalid");
  });
});
