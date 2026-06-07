import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Principal } from "@hootifactory/auth";
import { loadEnv } from "@hootifactory/config";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// uiRouter wires its own /me, /orgs and repository routes then mounts the
// sub-routers. Sub-routers are stubbed to no-ops so this file targets the
// top-level handlers; direct deps are mocked for hermetic happy paths.
const listAccessibleOrgs = mock(async () => [{ id: "org_1", slug: "acme" }]);
const createOrganizationWithOwner = mock(async () => ({ id: "org_new", slug: "acme" }));
const createRepositoryForPrincipal = mock(
  async () =>
    ({ ok: true, repo: repoRow() }) as
      | { ok: true; repo: ReturnType<typeof repoRow> }
      | { ok: false; status: number; error: string },
);
const listRepositoriesForOrg = mock(async () => [repoRow()]);
let orgDenied: Response | undefined;
let requireUserResult: { ok: true; principal: Principal } | { ok: false; response: Response } = {
  ok: false,
  response: new Response(JSON.stringify({ error: "login required" }), { status: 401 }),
};

function repoRow() {
  return {
    id: "repo_1",
    orgId: "org_1",
    name: "containers",
    moduleId: "docker",
    kind: "hosted",
    visibility: "private",
    mountPath: "v2/acme/containers",
    description: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const env = { ...loadEnv(), AUTH_ALLOW_ORG_CREATION: true };

mock.module("@hootifactory/config", () => ({ env, loadEnv }));
mock.module("@hootifactory/auth", () => ({ createOrganizationWithOwner, listAccessibleOrgs }));
mock.module("@hootifactory/registry", () => ({
  registryPlugins: {
    all: () => [
      { id: "npm", displayName: "npm", mountSegment: "npm", capabilities: { proxyable: true } },
    ],
  },
}));
mock.module("@hootifactory/registry-application/repositories", () => ({
  createRepositoryForPrincipal,
  listRepositoriesForOrg,
}));
mock.module("./ui-repository-access", () => ({
  requireOrgAccess: async () => orgDenied,
  requireUserPrincipal: () => requireUserResult,
}));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
}));
mock.module("./ui-content", () => ({ registerContentRoutes: () => {} }));
mock.module("./ui-governance", () => ({ registerGovernanceRoutes: () => {} }));
mock.module("./ui-repository-config", () => ({ registerRepositoryConfigRoutes: () => {} }));
mock.module("./ui-tokens", () => ({ registerTokenRoutes: () => {} }));

const { uiRouter } = await import("./ui");

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const user: Principal = { kind: "user", userId: "user_1", username: "alice" };

function appWith(principal: Principal = { kind: "anonymous" }) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  router.route("/", uiRouter);
  return router;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ui top-level routes", () => {
  beforeEach(() => {
    orgDenied = undefined;
    requireUserResult = { ok: true, principal: user };
    env.AUTH_ALLOW_ORG_CREATION = true;
    createOrganizationWithOwner.mockClear();
    createRepositoryForPrincipal.mockClear();
    createRepositoryForPrincipal.mockResolvedValue({ ok: true, repo: repoRow() });
    listRepositoriesForOrg.mockClear();
  });

  test("GET /me returns 401 anonymous, principal when authed", async () => {
    expect((await appWith().fetch(new Request("http://localhost/me"))).status).toBe(401);
    const authed = await appWith(user).fetch(new Request("http://localhost/me"));
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ authenticated: true, principal: user });
  });

  test("GET /orgs returns empty for non-user and a list for a user", async () => {
    expect(await (await appWith().fetch(new Request("http://localhost/orgs"))).json()).toEqual({
      orgs: [],
    });
    const res = await appWith(user).fetch(new Request("http://localhost/orgs"));
    expect((await res.json()) as unknown).toEqual({ orgs: [{ id: "org_1", slug: "acme" }] });
  });

  test("GET /registry-modules summarizes the registered plugins", async () => {
    const res = await appWith().fetch(new Request("http://localhost/registry-modules"));
    const body = (await res.json()) as { modules: Array<{ id: string }> };
    expect(body.modules[0]?.id).toBe("npm");
  });

  test("POST /orgs is rejected when org creation is disabled", async () => {
    env.AUTH_ALLOW_ORG_CREATION = false;
    const res = await appWith(user).fetch(postJson("/orgs", { slug: "acme", displayName: "Acme" }));
    expect(res.status).toBe(403);
  });

  test("POST /orgs requires a user principal", async () => {
    requireUserResult = {
      ok: false,
      response: new Response(JSON.stringify({ error: "login required" }), { status: 401 }),
    };
    const res = await appWith().fetch(postJson("/orgs", { slug: "acme", displayName: "Acme" }));
    expect(res.status).toBe(401);
  });

  test("POST /orgs rejects invalid bodies", async () => {
    const res = await appWith(user).fetch(postJson("/orgs", { slug: "BAD SLUG" }));
    expect(res.status).toBe(400);
  });

  test("POST /orgs creates an organization", async () => {
    const res = await appWith(user).fetch(postJson("/orgs", { slug: "acme", displayName: "Acme" }));
    expect(res.status).toBe(201);
    expect(createOrganizationWithOwner).toHaveBeenCalledTimes(1);
  });

  test("POST /orgs maps a duplicate slug to a 409", async () => {
    createOrganizationWithOwner.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );
    const res = await appWith(user).fetch(postJson("/orgs", { slug: "acme", displayName: "Acme" }));
    expect(res.status).toBe(409);
  });

  test("GET /orgs/:orgId/repositories rejects malformed ids and surfaces denial", async () => {
    expect(
      (await appWith(user).fetch(new Request("http://localhost/orgs/bad/repositories"))).status,
    ).toBe(400);
    orgDenied = new Response("denied", { status: 401 });
    expect(
      (await appWith(user).fetch(new Request(`http://localhost/orgs/${ORG_ID}/repositories`)))
        .status,
    ).toBe(401);
  });

  test("GET /orgs/:orgId/repositories lists repositories for an authorized org", async () => {
    const res = await appWith(user).fetch(
      new Request(`http://localhost/orgs/${ORG_ID}/repositories`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: Array<{ id: string }> };
    expect(body.repositories[0]?.id).toBe("repo_1");
  });

  test("POST /orgs/:orgId/repositories creates a repository", async () => {
    const res = await appWith(user).fetch(
      postJson(`/orgs/${ORG_ID}/repositories`, { name: "containers", moduleId: "docker" }),
    );
    expect(res.status).toBe(201);
    expect(createRepositoryForPrincipal).toHaveBeenCalledTimes(1);
  });

  test("POST /orgs/:orgId/repositories surfaces service-level errors", async () => {
    createRepositoryForPrincipal.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "name already taken",
    });
    const res = await appWith(user).fetch(
      postJson(`/orgs/${ORG_ID}/repositories`, { name: "containers", moduleId: "docker" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name already taken" });
  });
});
