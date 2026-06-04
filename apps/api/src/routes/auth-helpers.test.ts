import { describe, expect, test } from "bun:test";
import { env } from "@hootifactory/config";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { browserFacingUrl, oidcCallbackUrl } from "./auth-helpers";

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

describe("auth helpers", () => {
  test("builds browser-facing URLs from the configured public origin", () => {
    const url = browserFacingUrl(
      context("http://internal.local/api/auth/oidc/callback?code=abc&state=xyz", {
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      }),
    );

    expect(url.href).toBe(
      new URL("/api/auth/oidc/callback?code=abc&state=xyz", `${env.APP_PUBLIC_URL}/`).href,
    );
    expect(url.host).toBe(new URL(env.APP_PUBLIC_URL).host);
  });

  test("builds OIDC callback URLs from the configured public origin", () => {
    expect(
      oidcCallbackUrl(
        context("http://internal.local/api/auth/oidc/start?returnTo=%2Fdashboard", {
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe(new URL("/api/auth/oidc/callback", `${env.APP_PUBLIC_URL}/`).href);
  });
});
