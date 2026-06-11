import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Covers the external policy + repository-config + organization route handlers.
// Authorization and the registry-platform data layer are mocked so happy and
// error branches run without DB.
type RepoRow = { id: string; orgId: string; name: string; visibility: string } & Record<
  string,
  unknown
>;
const repo: RepoRow = {
  id: "repo_1",
  orgId: "org_1",
  name: "containers",
  moduleId: "npm",
  kind: "proxy",
  visibility: "private",
  mountPath: "npm/acme/containers",
  description: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const virtualRepo: RepoRow = { ...repo, id: "repo_v", kind: "virtual", name: "virtual" };
const hostedMember: RepoRow = { ...repo, id: "repo_m", kind: "hosted", name: "member" };

let allow = true;
class VirtualMemberLimitExceededError extends Error {}
class VirtualMemberOrgMismatchError extends Error {}

const getRepositoryById = mock(async () => repo as RepoRow | null);
const getOrgQuota = mock(async () => ({ maxStorageBytes: 100, usedStorageBytes: 5 }));
const setOrgQuota = mock(async () => {});
const upsertScanPolicy = mock(async () => ({ id: "pol_1" }));
const applyRetention = mock(async () => 7);
const addUpstream = mock(async () => {});
const addVirtualMember = mock(async () => {});
const getOrganizationById = mock(
  async () => ({ id: "org_1", slug: "acme" }) as { id: string; slug: string } | null,
);
const createRepositoryForPrincipal = mock(
  async () =>
    ({ ok: true, repo }) as
      | { ok: true; repo: RepoRow }
      | { ok: false; status: number; code: string; error: string },
);

mock.module("@hootifactory/auth", () => ({
  authorize: async () => ({
    allowed: allow,
    code: allow ? "ok" : "insufficient_scope",
    reason: "denied",
  }),
  createRequestAuthorizer: () => async () => ({ allowed: allow }),
  getOrganizationById,
  listAccessibleOrgs: async () => [],
  httpStatusForDenial: (d: { code?: string }) => (d.code === "unauthenticated" ? 401 : 403),
  writeAudit: async () => {},
}));
mock.module("@hootifactory/registry-platform/governance", () => ({
  getOrgQuota,
  setOrgQuota,
  upsertScanPolicy,
}));
mock.module("@hootifactory/registry-platform/repositories", () => ({
  applyRetention,
  addUpstream,
  addVirtualMember,
  getRepositoryById,
  createRepositoryForPrincipal,
  countRepositoriesForOrg: async () => 0,
  listRepositoriesForOrg: async () => [],
  VirtualMemberLimitExceededError,
  VirtualMemberOrgMismatchError,
}));

const { registerApiV1PolicyRoutes } = await import("./api-v1-policy-routes");
const { registerApiV1RepositoryConfigRoutes } = await import("./api-v1-repository-config-routes");
const { registerApiV1OrganizationRoutes } = await import("./api-v1-organization-routes");

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const REPO_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "00000000-0000-4000-8000-000000000003";

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", { kind: "user", userId: "user_1", username: "alice" });
    await next();
  });
  registerApiV1PolicyRoutes(router);
  registerApiV1RepositoryConfigRoutes(router);
  registerApiV1OrganizationRoutes(router);
  return router;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("api v1 policy routes", () => {
  beforeEach(() => {
    allow = true;
    getRepositoryById.mockResolvedValue(repo);
  });

  test("POST scan-policy upserts a valid policy", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/scan-policies`, { mode: "enforce", repositoryPattern: "team-*" }),
    );
    expect(res.status).toBe(201);
    expect(upsertScanPolicy).toHaveBeenCalled();
  });

  test("POST scan-policy denies when unauthorized", async () => {
    allow = false;
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/scan-policies`, { mode: "enforce" }),
    );
    expect(res.status).toBe(403);
  });

  test("POST scan-policy rejects an invalid pattern", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/scan-policies`, {
        mode: "enforce",
        repositoryPattern: "bad pattern!!",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("GET quota returns the org quota", async () => {
    const res = await appWithRoutes().fetch(new Request(`http://localhost/orgs/${ORG_ID}/quota`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { maxStorageBytes: number } };
    expect(body.data.maxStorageBytes).toBe(100);
  });

  test("POST quota updates limits", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/quota`, { maxStorageBytes: 1 }),
    );
    expect(res.status).toBe(200);
    expect(setOrgQuota).toHaveBeenCalled();
  });

  test("POST retention returns 404 when the repo is missing", async () => {
    getRepositoryById.mockResolvedValueOnce(null);
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/retention/apply`, {}),
    );
    expect(res.status).toBe(404);
  });

  test("POST retention applies pruning", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/retention/apply`, { keepLastN: 3 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { pruned: number } };
    expect(body.data.pruned).toBe(7);
  });
});

describe("api v1 repository config routes", () => {
  beforeEach(() => {
    allow = true;
    getRepositoryById.mockResolvedValue(repo);
  });

  test("POST upstreams adds a public upstream to a proxy repo", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/upstreams`, { url: "https://registry.example.test/" }),
    );
    expect(res.status).toBe(201);
    expect(addUpstream).toHaveBeenCalled();
  });

  test("POST upstreams rejects a non-proxy parent", async () => {
    getRepositoryById.mockResolvedValueOnce({ ...repo, kind: "hosted" });
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/upstreams`, { url: "https://registry.example.test/" }),
    );
    expect(res.status).toBe(400);
  });

  test("POST members adds a hosted member to a virtual repo", async () => {
    getRepositoryById.mockResolvedValueOnce(virtualRepo).mockResolvedValueOnce(hostedMember);
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/members`, { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(201);
    expect(addVirtualMember).toHaveBeenCalled();
  });

  test("POST members returns 404 when the member candidate is missing", async () => {
    getRepositoryById.mockResolvedValueOnce(virtualRepo).mockResolvedValueOnce(null);
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/members`, { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  test("POST members maps the limit error to a 400", async () => {
    getRepositoryById.mockResolvedValueOnce(virtualRepo).mockResolvedValueOnce(hostedMember);
    addVirtualMember.mockRejectedValueOnce(new VirtualMemberLimitExceededError("too many members"));
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/members`, { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });
});

describe("api v1 organization routes", () => {
  beforeEach(() => {
    allow = true;
    getOrganizationById.mockResolvedValue({ id: "org_1", slug: "acme" });
    createRepositoryForPrincipal.mockResolvedValue({ ok: true, repo });
  });

  test("GET /me reports an authenticated user principal", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/me"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { authenticated: boolean } };
    expect(body.data.authenticated).toBe(true);
  });

  test("GET /orgs returns the accessible orgs for a user", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/orgs"));
    expect(res.status).toBe(200);
  });

  test("GET /orgs/:orgId returns org metadata when authorized", async () => {
    const res = await appWithRoutes().fetch(new Request(`http://localhost/orgs/${ORG_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("org_1");
  });

  test("GET /orgs/:orgId returns 404 when the org is missing", async () => {
    getOrganizationById.mockResolvedValueOnce(null);
    const res = await appWithRoutes().fetch(new Request(`http://localhost/orgs/${ORG_ID}`));
    expect(res.status).toBe(404);
  });

  test("POST /orgs/:orgId/repositories creates a repository", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/repositories`, { name: "containers", moduleId: "npm" }),
    );
    expect(res.status).toBe(201);
    expect(createRepositoryForPrincipal).toHaveBeenCalled();
  });

  test("POST /orgs/:orgId/repositories surfaces service errors", async () => {
    createRepositoryForPrincipal.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONFLICT",
      error: "name taken",
    });
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/repositories`, { name: "containers", moduleId: "npm" }),
    );
    expect(res.status).toBe(409);
  });
});
