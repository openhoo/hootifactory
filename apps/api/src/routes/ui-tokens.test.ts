import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Principal } from "@hootifactory/auth";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// ui-tokens only pulls a handful of token-management functions from the auth
// barrel; mocking just those (plus the small sibling guards) keeps the graph
// hermetic without re-declaring the entire auth surface.
type Decision = { allowed: boolean; code?: string; reason?: string };
const visibleTokensForPrincipal = mock(
  async () =>
    ({
      ok: false,
      decision: { allowed: false, code: "unauthenticated", reason: "login required" },
    }) as
      | {
          ok: true;
          value: Array<{
            token: Record<string, unknown>;
            ownerUsername: string | null;
            grants: unknown[];
          }>;
        }
      | { ok: false; decision: Decision },
);
const getApiTokenById = mock(async () => null as { id: string; orgId: string } | null);
const tokenResourceDecision = mock(
  async (): Promise<Decision> => ({ allowed: false, code: "forbidden", reason: "nope" }),
);
const revokeToken = mock(async () => {});
const authorizeTokenCreation = mock(
  async (): Promise<Decision> => ({ allowed: false, code: "forbidden", reason: "nope" }),
);
const createApiToken = mock(async () => ({ token: tokenRow(), secret: "hoot_secret" }));
const validateCreatedTokenGrant = mock(
  async () =>
    ({ ok: true, value: undefined }) as
      | { ok: true; value: undefined }
      | { ok: false; decision: Decision },
);

let requireUserResult: { ok: true; principal: Principal } | { ok: false; response: Response } = {
  ok: false,
  response: new Response(JSON.stringify({ error: "login required" }), { status: 401 }),
};

function tokenRow() {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    ownerUserId: "user_1",
    name: "ci",
    tokenPrefix: "hoot_x",
    type: "personal",
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedByTokenId: null,
    revocationReason: null,
    rotatedAt: null,
    rotatedByUserId: null,
    rotatedByTokenId: null,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

mock.module("@hootifactory/auth", () => ({
  authorizeTokenCreation,
  createApiToken,
  getApiTokenById,
  principalActor: () => ({ userId: "user_1", tokenId: null }),
  resolveCreateApiTokenRequest: (body: { name: string; grants?: unknown[]; type?: string }) => ({
    name: body.name,
    type: body.type ?? "personal",
    grants: body.grants ?? [],
    expiresAt: null,
  }),
  revokeToken,
  tokenResourceDecision,
  validateCreatedTokenGrant,
  visibleTokensForPrincipal,
}));
mock.module("./ui-repository-access", () => ({
  requireUserPrincipal: () => requireUserResult,
}));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
  denied: (c: { json: (b: unknown, s: number) => Response }, d: Decision) =>
    c.json({ error: d.reason }, d.code === "unauthenticated" ? 401 : 403),
}));

const { registerTokenRoutes } = await import("./ui-tokens");

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_ID = "00000000-0000-4000-8000-000000000002";
const user: Principal = { kind: "user", userId: "user_1", username: "alice" };
const tokenCreateBody = { name: "ci", grants: [{ permission: "org.read" }] };

function appWith(principal: Principal = { kind: "anonymous" }) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  registerTokenRoutes(router);
  return router;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ui token routes", () => {
  beforeEach(() => {
    requireUserResult = {
      ok: false,
      response: new Response(JSON.stringify({ error: "login required" }), { status: 401 }),
    };
    for (const m of [
      visibleTokensForPrincipal,
      getApiTokenById,
      tokenResourceDecision,
      revokeToken,
      authorizeTokenCreation,
      createApiToken,
      validateCreatedTokenGrant,
    ]) {
      m.mockClear();
    }
  });

  test("GET tokens rejects malformed org ids", async () => {
    expect((await appWith().fetch(new Request("http://localhost/orgs/bad/tokens"))).status).toBe(
      400,
    );
  });

  test("GET tokens returns the guard denial", async () => {
    const res = await appWith().fetch(new Request(`http://localhost/orgs/${ORG_ID}/tokens`));
    expect(res.status).toBe(401);
  });

  test("GET tokens serializes the visible tokens", async () => {
    visibleTokensForPrincipal.mockResolvedValueOnce({
      ok: true,
      value: [{ token: tokenRow(), ownerUsername: "alice", grants: [] }],
    });
    const res = await appWith(user).fetch(new Request(`http://localhost/orgs/${ORG_ID}/tokens`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ ownerUsername: string }> };
    expect(body.tokens[0]?.ownerUsername).toBe("alice");
  });

  test("DELETE token returns 404 when not found", async () => {
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/tokens/${TOKEN_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  test("DELETE token returns 404 when token belongs to another org", async () => {
    getApiTokenById.mockResolvedValueOnce({ id: TOKEN_ID, orgId: "other-org" });
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/tokens/${TOKEN_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  test("DELETE token denies an unauthorized revoke", async () => {
    getApiTokenById.mockResolvedValueOnce({ id: TOKEN_ID, orgId: ORG_ID });
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/tokens/${TOKEN_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
  });

  test("DELETE token revokes when authorized", async () => {
    getApiTokenById.mockResolvedValueOnce({ id: TOKEN_ID, orgId: ORG_ID });
    tokenResourceDecision.mockResolvedValueOnce({ allowed: true });
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/tokens/${TOKEN_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(revokeToken).toHaveBeenCalledTimes(1);
  });

  test("POST token requires a user principal", async () => {
    const res = await appWith().fetch(postJson(`/orgs/${ORG_ID}/tokens`, tokenCreateBody));
    expect(res.status).toBe(401);
  });

  test("POST token denies unauthorized creation", async () => {
    requireUserResult = { ok: true, principal: user };
    const res = await appWith(user).fetch(postJson(`/orgs/${ORG_ID}/tokens`, tokenCreateBody));
    expect(res.status).toBe(403);
  });

  test("POST token denies when the grant is invalid", async () => {
    requireUserResult = { ok: true, principal: user };
    authorizeTokenCreation.mockResolvedValueOnce({ allowed: true });
    validateCreatedTokenGrant.mockResolvedValueOnce({
      ok: false,
      decision: { allowed: false, code: "forbidden", reason: "grant too broad" },
    });
    const res = await appWith(user).fetch(postJson(`/orgs/${ORG_ID}/tokens`, tokenCreateBody));
    expect(res.status).toBe(403);
  });

  test("POST token creates and returns the secret once", async () => {
    requireUserResult = { ok: true, principal: user };
    authorizeTokenCreation.mockResolvedValueOnce({ allowed: true });
    const res = await appWith(user).fetch(postJson(`/orgs/${ORG_ID}/tokens`, tokenCreateBody));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: { id: string }; secret: string };
    expect(body.secret).toBe("hoot_secret");
    expect(createApiToken).toHaveBeenCalledTimes(1);
  });
});
