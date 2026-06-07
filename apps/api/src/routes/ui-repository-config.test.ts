import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Mock the access guard + repository service so member/upstream handlers run end
// to end. The real upstream/virtual-member validators stay in the graph.
type RepoRow = {
  id: string;
  orgId: string;
  name: string;
  moduleId: string;
  kind: string;
  visibility: string;
};
const virtualRepo: RepoRow = {
  id: "repo_virtual",
  orgId: "org_1",
  name: "virtual",
  moduleId: "npm",
  kind: "virtual",
  visibility: "public",
};
const proxyRepo: RepoRow = { ...virtualRepo, id: "repo_proxy", name: "proxy", kind: "proxy" };
const hostedMember: RepoRow = {
  id: "repo_member",
  orgId: "org_1",
  name: "member",
  moduleId: "npm",
  kind: "hosted",
  visibility: "public",
};

let accessResult: { ok: true; repo: RepoRow } | { ok: false; response: Response } = {
  ok: true,
  repo: virtualRepo,
};
let memberDecisionAllowed = true;

class VirtualMemberLimitExceededError extends Error {}
class VirtualMemberOrgMismatchError extends Error {}

const getRepositoryById = mock(async () => hostedMember as RepoRow | null);
const addUpstream = mock(async () => {});
const addVirtualMember = mock(async () => {});

mock.module("@hootifactory/auth", () => ({
  authorize: async () => ({ allowed: memberDecisionAllowed, code: "ok" }),
}));
mock.module("@hootifactory/registry-application/repositories", () => ({
  addUpstream,
  addVirtualMember,
  getRepositoryById,
  VirtualMemberLimitExceededError,
  VirtualMemberOrgMismatchError,
}));
mock.module("./ui-repository-access", () => ({
  requireRepositoryAccessFromParam: async () => accessResult,
}));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
}));

const { registerRepositoryConfigRoutes } = await import("./ui-repository-config");

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", { kind: "anonymous" });
    await next();
  });
  registerRepositoryConfigRoutes(router);
  return router;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MEMBER_ID = "00000000-0000-4000-8000-000000000099";

describe("ui repository config routes", () => {
  beforeEach(() => {
    accessResult = { ok: true, repo: virtualRepo };
    memberDecisionAllowed = true;
    getRepositoryById.mockClear();
    getRepositoryById.mockResolvedValue(hostedMember);
    addUpstream.mockClear();
    addVirtualMember.mockClear();
  });

  test("POST members rejects when the parent is not virtual", async () => {
    accessResult = { ok: true, repo: proxyRepo };
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_proxy/members", { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });

  test("POST members surfaces guard denial", async () => {
    accessResult = { ok: false, response: new Response("no", { status: 401 }) };
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_virtual/members", { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(401);
  });

  test("POST members returns 404 when the candidate is missing", async () => {
    getRepositoryById.mockResolvedValueOnce(null);
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_virtual/members", { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  test("POST members returns 404 when the candidate is unreadable", async () => {
    memberDecisionAllowed = false;
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_virtual/members", { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(404);
  });

  test("POST members adds a valid hosted member", async () => {
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_virtual/members", { memberRepoId: MEMBER_ID, position: 1 }),
    );
    expect(res.status).toBe(201);
    expect(addVirtualMember).toHaveBeenCalledTimes(1);
  });

  test("POST members maps the member-limit error to a 400", async () => {
    addVirtualMember.mockRejectedValueOnce(new VirtualMemberLimitExceededError("limit reached"));
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_virtual/members", { memberRepoId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "limit reached" });
  });

  test("POST upstreams rejects a non-proxy parent", async () => {
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_virtual/upstreams", { url: "https://registry.example.test/" }),
    );
    expect(res.status).toBe(400);
  });

  test("POST upstreams adds a valid public upstream", async () => {
    accessResult = { ok: true, repo: proxyRepo };
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_proxy/upstreams", {
        url: "https://registry.example.test/",
        priority: 1,
      }),
    );
    expect(res.status).toBe(201);
    expect(addUpstream).toHaveBeenCalledTimes(1);
  });

  test("POST upstreams rejects a private upstream host", async () => {
    accessResult = { ok: true, repo: proxyRepo };
    const res = await appWithRoutes().fetch(
      postJson("/repositories/repo_proxy/upstreams", { url: "http://127.0.0.1:8080" }),
    );
    expect(res.status).toBe(400);
  });
});
