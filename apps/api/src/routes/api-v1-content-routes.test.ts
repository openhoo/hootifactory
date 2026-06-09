import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Mock the registry-application data layer and authorization so the external
// content API handlers run end to end. The real validation/response/access
// helpers stay in the graph (authorize drives allow/deny).
type RepoRow = { id: string; orgId: string; name: string; visibility: string } & Record<
  string,
  unknown
>;
const repo: RepoRow = {
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

let allow = true;
const getRepositoryById = mock(async () => repo as RepoRow | null);
const getPackageWithRepository = mock(
  async () =>
    ({ pkg: { id: "pkg_1", name: "left-pad" }, repo }) as {
      pkg: { id: string; name: string };
      repo: RepoRow;
    } | null,
);
const getArtifactWithRepository = mock(
  async () =>
    ({ art: { id: "art_1", digest: "sha256:abc" }, repo }) as {
      art: { id: string; digest: string };
      repo: RepoRow;
    } | null,
);
const findLiveVersion = mock(
  async () =>
    ({ id: "ver_1", version: "1.0.0", metadata: {}, sizeBytes: 10, createdAt: new Date() }) as {
      id: string;
      version: string;
      metadata: unknown;
      sizeBytes: number;
      createdAt: Date;
    } | null,
);
const countRepositoryPackages = mock(async () => 3);
const listRepositoryPackageSummaries = mock(async () => [{ id: "pkg_1" }]);
const countLivePackageVersions = mock(async () => 2);
const listLivePackageVersionSummaries = mock(async () => [{ version: "1.0.0" }]);
const countRepositoryArtifacts = mock(async () => 1);
const listRepositoryArtifactSummaries = mock(async () => [{ id: "art_1" }]);
const countArtifactFindings = mock(async () => 4);
const listArtifactFindings = mock(async () => [{ id: "f1", severity: "high" }]);
const listRegistryAssetsForRepository = mock(async () => ({
  assets: [{ id: "asset_1" }],
  total: 1,
}));

mock.module("@hootifactory/auth", () => ({
  authorize: async () => ({
    allowed: allow,
    code: allow ? "ok" : "insufficient_scope",
    reason: "denied",
  }),
  createRequestAuthorizer: () => async () => ({ allowed: allow }),
  getOrganizationById: async () => null,
  listAccessibleOrgs: async () => [],
  httpStatusForDenial: (d: { code?: string }) => (d.code === "unauthenticated" ? 401 : 403),
}));
mock.module("@hootifactory/registry-application/inventory", () => ({
  countArtifactFindings,
  countLivePackageVersions,
  countRepositoryArtifacts,
  countRepositoryPackages,
  getArtifactWithRepository,
  getPackageWithRepository,
  listArtifactFindings,
  listLivePackageVersionSummaries,
  listRepositoryArtifactSummaries,
  listRepositoryPackageSummaries,
}));
mock.module("@hootifactory/registry-application/repositories", () => ({
  findLiveVersion,
  getRepositoryById,
  // Present so api-v1-access (pulled via api-v1-helpers) links.
  countRepositoriesForOrg: async () => 0,
  listRepositoriesForOrg: async () => [],
}));
mock.module("@hootifactory/registry-application/assets", () => ({
  listRegistryAssetsForRepository,
}));

const { registerApiV1ContentRoutes } = await import("./api-v1-content-routes");

const REPO_ID = "00000000-0000-4000-8000-000000000001";
const PKG_ID = "00000000-0000-4000-8000-000000000002";
const ART_ID = "00000000-0000-4000-8000-000000000003";

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    c.set("principal", { kind: "user", userId: "user_1", username: "alice" });
    await next();
  });
  registerApiV1ContentRoutes(router);
  return router;
}

async function get(path: string) {
  const res = await appWithRoutes().fetch(new Request(`http://localhost${path}`));
  return res;
}

describe("api v1 content routes", () => {
  beforeEach(() => {
    allow = true;
    getRepositoryById.mockResolvedValue(repo);
    getPackageWithRepository.mockResolvedValue({ pkg: { id: "pkg_1", name: "left-pad" }, repo });
    getArtifactWithRepository.mockResolvedValue({
      art: { id: "art_1", digest: "sha256:abc" },
      repo,
    });
    findLiveVersion.mockResolvedValue({
      id: "ver_1",
      version: "1.0.0",
      metadata: {},
      sizeBytes: 10,
      createdAt: new Date(),
    });
  });

  test("GET repository returns detail with a package count", async () => {
    const res = await get(`/repositories/${REPO_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { repository: { id: string }; packageCount: number };
    };
    expect(body.data.packageCount).toBe(3);
  });

  test("GET repository returns 404 when missing", async () => {
    getRepositoryById.mockResolvedValueOnce(null);
    expect((await get(`/repositories/${REPO_ID}`)).status).toBe(404);
  });

  test("GET repository denies when unauthorized", async () => {
    allow = false;
    expect((await get(`/repositories/${REPO_ID}`)).status).toBe(403);
  });

  test("GET repository packages paginates", async () => {
    const res = await get(`/repositories/${REPO_ID}/packages?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pagination: { total: number } };
    expect(body.pagination.total).toBe(3);
  });

  test("GET package versions returns 404 for an unknown package", async () => {
    getPackageWithRepository.mockResolvedValueOnce(null);
    expect((await get(`/packages/${PKG_ID}/versions`)).status).toBe(404);
  });

  test("GET package versions lists versions", async () => {
    const res = await get(`/packages/${PKG_ID}/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { versions: unknown[] };
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(2);
  });

  test("GET package version detail returns assets", async () => {
    const res = await get(`/packages/${PKG_ID}/versions/1.0.0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { assets: unknown[] } };
    expect(body.data.assets).toHaveLength(1);
  });

  test("GET package version returns 404 when the version is missing", async () => {
    findLiveVersion.mockResolvedValueOnce(null);
    expect((await get(`/packages/${PKG_ID}/versions/9.9.9`)).status).toBe(404);
  });

  test("GET repository artifacts paginates", async () => {
    const res = await get(`/repositories/${REPO_ID}/artifacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
  });

  test("GET repository assets paginates with filters", async () => {
    const res = await get(`/repositories/${REPO_ID}/assets?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { total: number } };
    expect(body.pagination.total).toBe(1);
  });

  test("GET artifact findings returns 404 for an unknown artifact", async () => {
    getArtifactWithRepository.mockResolvedValueOnce(null);
    expect((await get(`/artifacts/${ART_ID}/findings`)).status).toBe(404);
  });

  test("GET artifact findings lists findings", async () => {
    const res = await get(`/artifacts/${ART_ID}/findings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pagination: { total: number } };
    expect(body.pagination.total).toBe(4);
  });
});
