import { describe, expect, test } from "bun:test";
import { app } from "../app";
import { registerAdapters } from "../bootstrap";

// These exercise the route handlers through the real app with anonymous and
// malformed requests. Anonymous principals are authorized purely (no permission
// grants to load), so authorization denials and request-validation failures
// run end-to-end without any DB access. Happy-path/DB branches are covered by
// the integration suite.
registerAdapters();

const UUID = "00000000-0000-4000-8000-000000000000";

async function fetchJson(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  return { status: res.status, body: await res.json().catch(() => null) };
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("api v1 identity + organization guards", () => {
  test("GET /api/v1/me returns 401 for anonymous callers", async () => {
    expect((await fetchJson("/api/v1/me")).status).toBe(401);
  });

  test("GET /api/v1/orgs returns 401 for anonymous callers", async () => {
    expect((await fetchJson("/api/v1/orgs")).status).toBe(401);
  });

  test("GET /api/v1/orgs/:orgId rejects malformed org ids", async () => {
    expect((await fetchJson("/api/v1/orgs/not-a-uuid")).status).toBe(400);
  });

  test("GET /api/v1/orgs/:orgId denies anonymous reads of a valid org id", async () => {
    expect((await fetchJson(`/api/v1/orgs/${UUID}`)).status).toBe(401);
  });

  test("GET /api/v1/orgs/:orgId/repositories rejects malformed pagination", async () => {
    expect((await fetchJson(`/api/v1/orgs/${UUID}/repositories?limit=0`)).status).toBe(400);
  });

  test("POST /api/v1/orgs/:orgId/repositories rejects malformed org ids", async () => {
    expect((await fetchJson("/api/v1/orgs/bad/repositories", postJson({}))).status).toBe(400);
  });
});

describe("api v1 content guards", () => {
  test("rejects malformed repository ids", async () => {
    expect((await fetchJson("/api/v1/repositories/bad")).status).toBe(400);
    expect((await fetchJson("/api/v1/repositories/bad/packages")).status).toBe(400);
    expect((await fetchJson("/api/v1/repositories/bad/artifacts")).status).toBe(400);
    expect((await fetchJson("/api/v1/repositories/bad/assets")).status).toBe(400);
  });

  test("rejects malformed package and artifact ids", async () => {
    expect((await fetchJson("/api/v1/packages/bad/versions")).status).toBe(400);
    expect((await fetchJson("/api/v1/packages/bad/versions/1.0.0")).status).toBe(400);
    expect((await fetchJson("/api/v1/artifacts/bad/findings")).status).toBe(400);
  });

  test("rejects malformed pagination on valid ids before any data access", async () => {
    expect((await fetchJson(`/api/v1/repositories/${UUID}/packages?limit=0`)).status).toBe(400);
  });
});

describe("api v1 policy guards", () => {
  test("denies anonymous scan policy upserts on a valid org id", async () => {
    expect(
      (await fetchJson(`/api/v1/orgs/${UUID}/scan-policies`, postJson({ mode: "enforce" }))).status,
    ).toBe(401);
  });

  test("denies anonymous quota reads and writes on a valid org id", async () => {
    expect((await fetchJson(`/api/v1/orgs/${UUID}/quota`)).status).toBe(401);
    expect((await fetchJson(`/api/v1/orgs/${UUID}/quota`, postJson({}))).status).toBe(401);
  });

  test("rejects malformed repository ids for retention", async () => {
    expect((await fetchJson("/api/v1/repositories/bad/retention/apply", postJson({}))).status).toBe(
      400,
    );
  });
});

describe("api v1 repository-config guards", () => {
  test("rejects malformed repository ids for upstreams and members", async () => {
    expect((await fetchJson("/api/v1/repositories/bad/upstreams", postJson({}))).status).toBe(400);
    expect((await fetchJson("/api/v1/repositories/bad/members", postJson({}))).status).toBe(400);
  });
});

describe("api v1 token guards", () => {
  test("denies anonymous token listing on a valid org id", async () => {
    expect((await fetchJson(`/api/v1/orgs/${UUID}/tokens`)).status).toBe(401);
  });

  test("rejects malformed pagination for token listing", async () => {
    expect((await fetchJson(`/api/v1/orgs/${UUID}/tokens?limit=0`)).status).toBe(400);
  });

  test("requires a user principal before creating tokens", async () => {
    expect(
      (
        await fetchJson(
          `/api/v1/orgs/${UUID}/tokens`,
          postJson({ name: "ci", grants: [{ permission: "org.read" }] }),
        )
      ).status,
    ).toBe(401);
  });

  test("rejects malformed token ids", async () => {
    expect((await fetchJson("/api/v1/tokens/bad")).status).toBe(400);
    expect((await fetchJson("/api/v1/tokens/bad/rotate", { method: "POST" })).status).toBe(400);
    expect((await fetchJson(`/api/v1/orgs/${UUID}/tokens/bad`, { method: "DELETE" })).status).toBe(
      400,
    );
  });
});

describe("ui route guards", () => {
  test("GET /api/me returns 401 for anonymous callers", async () => {
    expect((await fetchJson("/api/me")).status).toBe(401);
  });

  test("GET /api/orgs returns an empty list for anonymous callers", async () => {
    const { status, body } = await fetchJson("/api/orgs");
    expect(status).toBe(200);
    expect(body).toEqual({ orgs: [] });
  });

  test("GET /api/registry-modules lists registered modules", async () => {
    const { status, body } = await fetchJson("/api/registry-modules");
    expect(status).toBe(200);
    const modules = (body as { modules: Array<{ id: string }> }).modules;
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some((m) => m.id === "npm")).toBe(true);
  });

  test("GET /api/orgs/:orgId/repositories rejects malformed org ids and denies anonymous", async () => {
    expect((await fetchJson("/api/orgs/bad/repositories")).status).toBe(400);
    expect((await fetchJson(`/api/orgs/${UUID}/repositories`)).status).toBe(401);
  });

  test("POST /api/orgs/:orgId/repositories rejects malformed bodies", async () => {
    expect((await fetchJson(`/api/orgs/${UUID}/repositories`, postJson({}))).status).toBe(400);
  });

  test("ui content routes reject malformed ids", async () => {
    expect((await fetchJson("/api/repositories/bad")).status).toBe(400);
    expect((await fetchJson("/api/repositories/bad/packages")).status).toBe(400);
    expect((await fetchJson("/api/packages/bad/versions")).status).toBe(400);
    expect((await fetchJson("/api/repositories/bad/artifacts")).status).toBe(400);
    expect((await fetchJson("/api/artifacts/bad/findings")).status).toBe(400);
  });

  test("ui repository-config routes reject malformed ids", async () => {
    expect((await fetchJson("/api/repositories/bad/members", postJson({}))).status).toBe(400);
    expect((await fetchJson("/api/repositories/bad/upstreams", postJson({}))).status).toBe(400);
    expect((await fetchJson("/api/repositories/bad/retention/apply", postJson({}))).status).toBe(
      400,
    );
  });

  test("ui governance routes deny anonymous on valid org ids and reject malformed ids", async () => {
    expect((await fetchJson("/api/orgs/bad/quota")).status).toBe(400);
    expect((await fetchJson(`/api/orgs/${UUID}/quota`)).status).toBe(401);
    expect((await fetchJson(`/api/orgs/${UUID}/quota`, postJson({}))).status).toBe(401);
    expect(
      (await fetchJson(`/api/orgs/${UUID}/scan-policies`, postJson({ mode: "enforce" }))).status,
    ).toBe(401);
  });

  test("ui token routes deny anonymous and reject malformed ids", async () => {
    expect((await fetchJson("/api/orgs/bad/tokens")).status).toBe(400);
    expect((await fetchJson(`/api/orgs/${UUID}/tokens`)).status).toBe(401);
    expect((await fetchJson(`/api/orgs/${UUID}/tokens`, postJson({ name: "ci" }))).status).toBe(
      401,
    );
    // DELETE of a valid (non-malformed) token id loads the token from the DB
    // before the authorization gate runs, so it is not a DB-free guard path and
    // is covered hermetically by ui-tokens.test.ts ("DELETE token returns 404
    // when not found"). Asserting it here only passed by accident when a sibling
    // token test's process-global `mock.module("@hootifactory/auth")` happened to
    // be active, which races under `bun test --parallel`.
  });
});

describe("auth route guards", () => {
  test("GET /api/auth/methods reports configured methods", async () => {
    const { status, body } = await fetchJson("/api/auth/methods");
    expect(status).toBe(200);
    expect(body).toMatchObject({ password: true });
  });

  test("POST /api/auth/login rejects malformed bodies", async () => {
    expect((await fetchJson("/api/auth/login", postJson({}))).status).toBe(400);
  });

  test("POST /api/auth/logout clears the session without a cookie", async () => {
    const { status, body } = await fetchJson("/api/auth/logout", { method: "POST" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  test("GET /api/auth/me returns 401 for anonymous callers", async () => {
    expect((await fetchJson("/api/auth/me")).status).toBe(401);
  });

  test("GET /api/auth/oidc/start returns 404 while OIDC is disabled", async () => {
    expect((await fetchJson("/api/auth/oidc/start")).status).toBe(404);
  });

  test("GET /api/auth/oidc/callback redirects when OIDC is disabled", async () => {
    const res = await app.fetch(new Request("http://localhost/api/auth/oidc/callback"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=");
  });

  test("GET /api/auth/oidc/link/confirm renders the confirmation page for a valid token", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/link/confirm?token=abcdefabcdefabcdef"),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Confirm SSO sign-in");
    expect(res.headers.get("set-cookie")).toContain("hoot_oidc_link_confirm=");
  });

  test("GET /api/auth/oidc/link/confirm redirects when the token query is invalid", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/link/confirm?token=short"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_invalid");
  });

  test("POST /api/auth/oidc/link/confirm redirects on a missing CSRF cookie", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/link/confirm", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "abcdefabcdefabcdef",
          csrf: "csrfcsrfcsrfcsrf",
        }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_invalid");
  });

  test("POST /api/auth/oidc/link/confirm redirects on an invalid body", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/auth/oidc/link/confirm", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "x" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_link_invalid");
  });
});
