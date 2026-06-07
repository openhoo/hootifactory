import { describe, expect, test } from "bun:test";
import { env } from "@hootifactory/config";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  browserFacingUrl,
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
  setSessionCookie,
} from "./auth-helpers";

function context(url: string, headers: Record<string, string> = {}): Context<AppEnv> {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    req: {
      url,
      header: (name: string) => normalizedHeaders[name.toLowerCase()],
    },
  } as unknown as Context<AppEnv>;
}

// Drive the cookie helpers through a real Hono app so getCookie/setCookie operate
// on genuine request/response headers (hermetic, no DB).
async function runRoute(handler: (c: Context<AppEnv>) => void, requestInit?: RequestInit) {
  const app = new Hono<AppEnv>();
  app.get("/probe", (c) => {
    handler(c);
    return c.json({ ok: true });
  });
  return app.fetch(new Request("http://localhost/probe", requestInit));
}

describe("auth helpers", () => {
  test("builds browser-facing URLs from the configured public origin", () => {
    const url = browserFacingUrl(
      context("http://internal.local/api/auth/oidc/callback?code=abc&state=xyz", {
        "x-forwarded-host": "attacker.example",
      }),
    );
    expect(url.host).toBe(new URL(env.APP_PUBLIC_URL).host);
    expect(url.pathname).toBe("/api/auth/oidc/callback");
  });

  test("builds OIDC callback URLs without preserving the request query", () => {
    expect(
      oidcCallbackUrl(context("http://internal.local/api/auth/oidc/start?returnTo=%2Fdashboard")),
    ).toBe(new URL("/api/auth/oidc/callback", `${env.APP_PUBLIC_URL}/`).href);
  });

  test("oidcConfig returns null while OIDC stays disabled", () => {
    expect(oidcConfig()).toBeNull();
  });

  test("builds login redirect targets with encoded query parameters", () => {
    expect(loginRedirect()).toBe("/login?error=sso_failed");
    expect(loginRedirect("sso_state")).toBe("/login?error=sso_state");
    expect(loginNoticeRedirect("sso_link_email")).toBe("/login?notice=sso_link_email");
  });

  test("publicUrl resolves paths against the configured app origin", () => {
    expect(publicUrl("/reset-password?token=abc")).toBe(
      new URL("/reset-password?token=abc", `${env.APP_PUBLIC_URL}/`).href,
    );
  });

  test("enqueueEmail is a no-op while email delivery is disabled", async () => {
    await expect(
      enqueueEmail({ template: "password_reset", to: "a@b.test", deliveryKey: "k" } as never),
    ).resolves.toBeUndefined();
  });

  test("sets and reads the OIDC state cookie round-trip", async () => {
    const set = await runRoute((c) =>
      setOidcStateCookie(c, "state-value", new Date(Date.now() + 60_000)),
    );
    const cookie = set.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hoot_oidc_state=state-value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/auth/oidc");

    let read: string | undefined;
    await runRoute(
      (c) => {
        read = readOidcStateCookie(c);
      },
      { headers: { cookie: "hoot_oidc_state=state-value" } },
    );
    expect(read).toBe("state-value");
  });

  test("deletes the OIDC state cookie with the scoped path", async () => {
    const res = await runRoute((c) => deleteOidcStateCookie(c));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hoot_oidc_state=");
    expect(cookie).toContain("Max-Age=0");
  });

  test("sets and reads the session cookie round-trip", async () => {
    const set = await runRoute((c) =>
      setSessionCookie(c, "secret-value", new Date(Date.now() + 60_000)),
    );
    const cookie = set.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hoot_session=secret-value");
    expect(cookie).toContain("Path=/");

    let read: string | undefined;
    await runRoute(
      (c) => {
        read = readSessionCookie(c);
      },
      { headers: { cookie: "hoot_session=secret-value" } },
    );
    expect(read).toBe("secret-value");
  });

  test("deletes the session cookie", async () => {
    const res = await runRoute((c) => deleteSessionCookie(c));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hoot_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});
