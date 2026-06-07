import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";

// Mock the small access-guard sibling so we never touch the auth/DB stack; each
// guard result is set per-test. Inventory counts are stubbed directly.
type RepoRow = { id: string; orgId: string; name: string; visibility: string };
const repo: RepoRow = { id: "repo_1", orgId: "org_1", name: "containers", visibility: "private" };

let accessResult: { ok: true; repo: RepoRow } | { ok: false; response: Response } = {
  ok: true,
  repo,
};
let parentDenied: Response | undefined;
let packageRow: { pkg: { id: string; name: string }; repo: RepoRow } | undefined = {
  pkg: { id: "pkg_1", name: "left-pad" },
  repo,
};

const countRepositoryPackages = mock(async () => 3);
const listRepositoryPackageSummaries = mock(async () => [{ id: "pkg_1", name: "left-pad" }]);
const countLivePackageVersions = mock(async () => 2);
const listLivePackageVersionSummaries = mock(async () => [{ version: "1.0.0" }]);
const getPackageWithRepository = mock(async () => packageRow);

mock.module("@hootifactory/registry-application/inventory", () => ({
  countRepositoryPackages,
  countLivePackageVersions,
  getPackageWithRepository,
  listLivePackageVersionSummaries,
  listRepositoryPackageSummaries,
}));
mock.module("./ui-repository-access", () => ({
  requireRepositoryAccessFromParam: async () => accessResult,
  requireReadableParentRepo: async () => parentDenied,
}));

const { registerContentRoutes } = await import("./ui-content");

function appWithRoutes() {
  const router = new Hono<AppEnv>();
  registerContentRoutes(router);
  return router;
}

const PKG_ID = "00000000-0000-4000-8000-000000000010";

describe("ui content routes", () => {
  beforeEach(() => {
    accessResult = { ok: true, repo };
    parentDenied = undefined;
    packageRow = { pkg: { id: "pkg_1", name: "left-pad" }, repo };
    for (const m of [
      countRepositoryPackages,
      listRepositoryPackageSummaries,
      countLivePackageVersions,
      listLivePackageVersionSummaries,
      getPackageWithRepository,
    ]) {
      m.mockClear();
    }
  });

  test("GET repository returns metadata and a package count", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/repositories/repo_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repository: { id: string }; packageCount: number };
    expect(body.repository.id).toBe("repo_1");
    expect(body.packageCount).toBe(3);
  });

  test("GET repository surfaces the guard's denial response", async () => {
    accessResult = { ok: false, response: new Response("denied", { status: 403 }) };
    const res = await appWithRoutes().fetch(new Request("http://localhost/repositories/repo_1"));
    expect(res.status).toBe(403);
  });

  test("GET repository packages paginates the summaries", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/repositories/repo_1/packages?limit=10&offset=0"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packages: unknown[]; pagination: { total: number } };
    expect(body.pagination.total).toBe(3);
    expect(body.packages).toHaveLength(1);
  });

  test("GET repository packages rejects invalid pagination", async () => {
    const res = await appWithRoutes().fetch(
      new Request("http://localhost/repositories/repo_1/packages?limit=0"),
    );
    expect(res.status).toBe(400);
  });

  test("GET package versions rejects malformed package ids", async () => {
    const res = await appWithRoutes().fetch(new Request("http://localhost/packages/bad/versions"));
    expect(res.status).toBe(400);
  });

  test("GET package versions surfaces the parent denial", async () => {
    parentDenied = new Response("nope", { status: 404 });
    const res = await appWithRoutes().fetch(
      new Request(`http://localhost/packages/${PKG_ID}/versions`),
    );
    expect(res.status).toBe(404);
  });

  test("GET package versions lists live versions for a readable package", async () => {
    const res = await appWithRoutes().fetch(
      new Request(`http://localhost/packages/${PKG_ID}/versions?limit=5`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      package: { id: string; name: string };
      versions: unknown[];
      pagination: { total: number };
    };
    expect(body.package).toEqual({ id: "pkg_1", name: "left-pad" });
    expect(body.pagination.total).toBe(2);
  });
});
