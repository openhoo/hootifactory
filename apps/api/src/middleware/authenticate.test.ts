import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { registerAdapters } from "../bootstrap";
import type { AppEnv } from "../types";
import { authenticate, SESSION_COOKIE } from "./authenticate";

// Register adapters so registryPlugins (used to detect registry-bearer paths and
// API key headers) is populated. Every case here avoids credentials that would
// require a DB lookup (no hoot_ tokens, no session cookies).
registerAdapters();

function probeApp() {
  const app = new Hono<AppEnv>();
  app.all("/*", async (c) => {
    const principal = await authenticate(c);
    return c.json({
      kind: principal.kind,
      source: c.get("authSource"),
      failure: c.get("registryAuthFailure"),
    });
  });
  // Mirror the real app's behavior of turning auth failures into HTTP statuses.
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err.message }, status as ContentfulStatusCode);
  });
  return app;
}

async function authResult(path: string, headers: Record<string, string> = {}) {
  const res = await probeApp().fetch(new Request(`http://localhost${path}`, { headers }));
  return (await res.json()) as { kind: string; source: string; failure?: string };
}

describe("authenticate middleware", () => {
  test("defaults to anonymous when no credentials are present", async () => {
    expect(await authResult("/healthz")).toEqual({
      kind: "anonymous",
      source: "anonymous",
      failure: undefined,
    });
  });

  test("rejects malformed authorization headers", async () => {
    const res = await probeApp().fetch(
      new Request("http://localhost/healthz", { headers: { authorization: "   " } }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects an unparseable basic credential", async () => {
    const res = await probeApp().fetch(
      new Request("http://localhost/healthz", { headers: { authorization: "Basic %%%notbase64" } }),
    );
    expect(res.status).toBe(401);
  });

  test("treats an invalid registry bearer token on a registry path as anonymous", async () => {
    const result = await authResult("/v2/acme/containers/manifests/latest", {
      authorization: "Bearer not-a-real-jwt",
    });
    expect(result.kind).toBe("anonymous");
    expect(result.source).toBe("authorization");
    expect(result.failure).toBe("invalid_token");
  });

  test("rejects an invalid bearer token on a non-registry path", async () => {
    const res = await probeApp().fetch(
      new Request("http://localhost/api/v1/me", {
        headers: { authorization: "Bearer not-a-real-jwt" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("rejects a bare token that does not match the hoot_ prefix", async () => {
    const res = await probeApp().fetch(
      new Request("http://localhost/healthz", { headers: { authorization: "some-opaque-value" } }),
    );
    expect(res.status).toBe(401);
  });

  test("exposes the session cookie name", () => {
    expect(SESSION_COOKIE).toBe("hoot_session");
  });
});
