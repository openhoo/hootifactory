import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// The governance routes guard on the access-control sibling and then call
// inventory/governance/repository services. Both are mocked so the handler
// bodies (serialization, pagination, audit) run hermetically.
type RepoRow = { id: string; orgId: string; name: string; visibility: string };
const repo: RepoRow = { id: "repo_1", orgId: "org_1", name: "containers", visibility: "private" };

let accessResult: { ok: true; repo: RepoRow } | { ok: false; response: Response } = {
  ok: true,
  repo,
};
let orgDenied: Response | undefined;
let scanFindingsDenied: Response | undefined;
let artifactRow: { art: { id: string }; repo: RepoRow } | undefined = {
  art: { id: "art_1" },
  repo,
};

const countRepositoryArtifacts = mock(async () => 1);
const listRepositoryArtifactSummaries = mock(async () => [
  { id: "art_1", digest: "sha256:abc", createdAt: new Date() },
]);
const getArtifactWithRepository = mock(async () => artifactRow);
const countArtifactFindings = mock(async () => 2);
const listArtifactFindings = mock(async () => [{ id: "f1", severity: "high" }]);
const getOrgQuota = mock(async () => ({ maxStorageBytes: 100, usedStorageBytes: 10 }));
const setOrgQuota = mock(async () => {});
const upsertScanPolicy = mock(async () => ({ id: "pol_1" }));
const applyRetention = mock(async () => 5);

mock.module("@hootifactory/registry-application/inventory", () => ({
  countRepositoryArtifacts,
  listRepositoryArtifactSummaries,
  getArtifactWithRepository,
  countArtifactFindings,
  listArtifactFindings,
}));
mock.module("@hootifactory/registry-application/governance", () => ({
  getOrgQuota,
  setOrgQuota,
  upsertScanPolicy,
}));
mock.module("@hootifactory/registry-application/repositories", () => ({ applyRetention }));
mock.module("./ui-repository-access", () => ({
  requireRepositoryAccessFromParam: async () => accessResult,
  requireOrgAccess: async () => orgDenied,
  requireScanFindingsAccess: async () => scanFindingsDenied,
}));
mock.module("./http", () => ({
  audit: () => {},
  AUDIT_RESULT: { success: "success", failure: "failure" },
}));

const { registerArtifactRoutes } = await import("./ui-artifact-routes");
const { registerQuotaRoutes } = await import("./ui-quota-routes");
const { registerScanPolicyRoutes } = await import("./ui-scan-policy-routes");
const { registerRetentionRoutes } = await import("./ui-retention-routes");

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  registerArtifactRoutes(router);
  registerQuotaRoutes(router);
  registerScanPolicyRoutes(router);
  registerRetentionRoutes(router);
  return router;
}

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ART_ID = "00000000-0000-4000-8000-000000000002";
const REPO_ID = "00000000-0000-4000-8000-000000000003";

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ui governance routes", () => {
  beforeEach(() => {
    accessResult = { ok: true, repo };
    orgDenied = undefined;
    scanFindingsDenied = undefined;
    artifactRow = { art: { id: "art_1" }, repo };
  });

  test("lists repository artifacts and strips createdAt", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/repositories/repo_1/artifacts"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifacts: Array<Record<string, unknown>>;
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(1);
    expect(body.artifacts[0]).not.toHaveProperty("createdAt");
  });

  test("artifact listing surfaces guard denial", async () => {
    accessResult = { ok: false, response: new Response("no", { status: 403 }) };
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/repositories/repo_1/artifacts"),
    );
    expect(res.status).toBe(403);
  });

  test("artifact listing rejects invalid pagination", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/repositories/repo_1/artifacts?limit=0"),
    );
    expect(res.status).toBe(400);
  });

  test("lists artifact findings for a valid artifact", async () => {
    const res = await appWithRoutes().fetch(
      new Request(`http://localhost/artifacts/${ART_ID}/findings`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; pagination: { total: number } };
    expect(body.pagination.total).toBe(2);
    expect(body.findings).toHaveLength(1);
  });

  test("artifact findings reject malformed ids", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/artifacts/bad/findings"));
    expect(res.status).toBe(400);
  });

  test("artifact findings surface scan-findings denial", async () => {
    scanFindingsDenied = new Response("denied", { status: 403 });
    const res = await appWithRoutes().fetch(
      new Request(`http://localhost/artifacts/${ART_ID}/findings`),
    );
    expect(res.status).toBe(403);
  });

  test("GET quota returns storage usage for an authorized org", async () => {
    const res = await appWithRoutes().fetch(new Request(`http://localhost/orgs/${ORG_ID}/quota`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxStorageBytes: 100, usedStorageBytes: 10 });
  });

  test("GET quota rejects malformed org ids and surfaces denial", async () => {
    expect(
      (await appWithRoutes().fetch(new Request("http://localhost/orgs/bad/quota"))).status,
    ).toBe(400);
    orgDenied = new Response("denied", { status: 401 });
    expect(
      (await appWithRoutes().fetch(new Request(`http://localhost/orgs/${ORG_ID}/quota`))).status,
    ).toBe(401);
  });

  test("POST quota updates limits for an authorized org", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/quota`, { maxStorageBytes: 5, maxArtifacts: 10 }),
    );
    expect(res.status).toBe(200);
    expect(setOrgQuota).toHaveBeenCalled();
  });

  test("POST scan-policy upserts with a valid pattern", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/scan-policies`, { mode: "enforce", repositoryPattern: "team-*" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ policy: { id: "pol_1" } });
  });

  test("POST scan-policy rejects an invalid repository pattern", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/orgs/${ORG_ID}/scan-policies`, {
        mode: "enforce",
        repositoryPattern: "bad pattern!!",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST retention applies pruning for an authorized repository", async () => {
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/retention/apply`, { keepLastN: 3 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 5 });
  });

  test("POST retention surfaces guard denial", async () => {
    accessResult = { ok: false, response: new Response("no", { status: 401 }) };
    const res = await appWithRoutes().fetch(
      postJson(`/repositories/${REPO_ID}/retention/apply`, {}),
    );
    expect(res.status).toBe(401);
  });
});
