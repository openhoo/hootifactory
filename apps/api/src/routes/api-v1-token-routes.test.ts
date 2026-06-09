import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Principal } from "@hootifactory/auth";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Drive the external token API handlers with mocked auth token-management +
// access guards. The real validation/response helpers stay in the graph, so
// path-param/pagination validation runs for real.
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
const getApiTokenWithOwner = mock(
  async () =>
    null as {
      token: Record<string, unknown>;
      ownerUsername: string | null;
      grants: unknown[];
    } | null,
);
const getTokenGrants = mock(async () => [] as unknown[]);
const tokenResourceDecision = mock(
  async (): Promise<Decision> => ({ allowed: false, code: "forbidden", reason: "no" }),
);
const revokeToken = mock(async () => {});
const rotateToken = mock(
  async () =>
    ({ token: tokenRow(), secret: "hoot_rot" }) as {
      token: Record<string, unknown>;
      secret: string;
    } | null,
);
const authorizeTokenCreation = mock(
  async (): Promise<Decision> => ({ allowed: false, code: "forbidden", reason: "no" }),
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
    orgId: "00000000-0000-4000-8000-000000000001",
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
  getApiTokenWithOwner,
  getTokenGrants,
  principalActor: () => ({ userId: "user_1", tokenId: null }),
  resolveCreateApiTokenRequest: (body: { name: string; grants?: unknown[]; type?: string }) => ({
    name: body.name,
    type: body.type ?? "personal",
    grants: body.grants ?? [],
    expiresAt: null,
  }),
  revokeToken,
  rotateToken,
  tokenResourceDecision,
  validateCreatedTokenGrant,
  visibleTokensForPrincipal,
  httpStatusForDenial: (d: Decision) => (d.code === "unauthenticated" ? 401 : 403),
  // Present so api-v1-access (pulled via api-v1-helpers) links, even though the
  // token routes never invoke generic authorization.
  authorize: async () => ({ allowed: false, code: "unauthenticated" }),
  authorizePermission: async () => ({ allowed: false, code: "unauthenticated" }),
  createRequestAuthorizer: () => async () => ({ allowed: false, code: "unauthenticated" }),
  getOrganizationById: async () => null,
  listAccessibleOrgs: async () => [],
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

const { registerApiV1TokenRoutes } = await import("./api-v1-token-routes");

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
  registerApiV1TokenRoutes(router);
  return router;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("api v1 token routes", () => {
  beforeEach(() => {
    requireUserResult = {
      ok: false,
      response: new Response(JSON.stringify({ error: "login required" }), { status: 401 }),
    };
    for (const m of [
      visibleTokensForPrincipal,
      getApiTokenById,
      getApiTokenWithOwner,
      getTokenGrants,
      tokenResourceDecision,
      revokeToken,
      rotateToken,
      authorizeTokenCreation,
      createApiToken,
      validateCreatedTokenGrant,
    ]) {
      m.mockClear();
    }
  });

  test("GET tokens lists visible tokens", async () => {
    visibleTokensForPrincipal.mockResolvedValueOnce({
      ok: true,
      value: [{ token: tokenRow(), ownerUsername: "alice", grants: [] }],
    });
    const res = await appWith(user).fetch(new Request(`http://localhost/orgs/${ORG_ID}/tokens`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
  });

  test("GET tokens denies when not visible", async () => {
    const res = await appWith().fetch(new Request(`http://localhost/orgs/${ORG_ID}/tokens`));
    expect(res.status).toBe(401);
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

  test("POST token creates and returns a secret", async () => {
    requireUserResult = { ok: true, principal: user };
    authorizeTokenCreation.mockResolvedValueOnce({ allowed: true });
    const res = await appWith(user).fetch(postJson(`/orgs/${ORG_ID}/tokens`, tokenCreateBody));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { secret: string } };
    expect(body.data.secret).toBe("hoot_secret");
  });

  test("GET token returns 404 when missing", async () => {
    const res = await appWith(user).fetch(new Request(`http://localhost/tokens/${TOKEN_ID}`));
    expect(res.status).toBe(404);
  });

  test("GET token returns metadata when authorized", async () => {
    getApiTokenWithOwner.mockResolvedValueOnce({
      token: tokenRow(),
      ownerUsername: "alice",
      grants: [],
    });
    tokenResourceDecision.mockResolvedValueOnce({ allowed: true });
    const res = await appWith(user).fetch(new Request(`http://localhost/tokens/${TOKEN_ID}`));
    expect(res.status).toBe(200);
  });

  test("POST rotate returns 404 when missing", async () => {
    const res = await appWith(user).fetch(
      new Request(`http://localhost/tokens/${TOKEN_ID}/rotate`, { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  test("POST rotate rotates an authorized token", async () => {
    getApiTokenById.mockResolvedValueOnce({ id: TOKEN_ID, orgId: ORG_ID });
    tokenResourceDecision.mockResolvedValueOnce({ allowed: true });
    const res = await appWith(user).fetch(
      new Request(`http://localhost/tokens/${TOKEN_ID}/rotate`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(rotateToken).toHaveBeenCalledTimes(1);
  });

  test("DELETE token returns 404 for the wrong org", async () => {
    getApiTokenById.mockResolvedValueOnce({ id: TOKEN_ID, orgId: "other" });
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/tokens/${TOKEN_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  test("DELETE token revokes an authorized token", async () => {
    getApiTokenById.mockResolvedValueOnce({ id: TOKEN_ID, orgId: ORG_ID });
    tokenResourceDecision.mockResolvedValueOnce({ allowed: true });
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/tokens/${TOKEN_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(revokeToken).toHaveBeenCalledTimes(1);
  });
});
