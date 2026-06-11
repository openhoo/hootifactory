import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedRepo } from "@hootifactory/registry";
import type { Context } from "hono";
import type { AppEnv } from "../types";

// Exercise listAccessibleRepositories' two paths (org-level read vs. per-repo
// fan-out) plus the thin data wrappers, with auth + the data layer mocked.
type Decision = { allowed: boolean };
let orgAllowed = true;
let perRepoAllowed = (_repo: ResolvedRepo) => true;

const repos: ResolvedRepo[] = [
  { id: "r1", orgId: "org_1", name: "a", visibility: "public" } as ResolvedRepo,
  { id: "r2", orgId: "org_1", name: "b", visibility: "private" } as ResolvedRepo,
  { id: "r3", orgId: "org_1", name: "c", visibility: "private" } as ResolvedRepo,
];

const countRepositoriesForOrg = mock(async () => repos.length);
const listRepositoriesForOrg = mock(
  async (_orgId: string, pagination?: { limit: number; offset: number }) =>
    pagination ? repos.slice(pagination.offset, pagination.offset + pagination.limit) : repos,
);
const getRepositoryById = mock(async () => repos[0] as ResolvedRepo | null);
const getPackageWithRepository = mock(async () => ({
  pkg: { id: "p1", name: "x" },
  repo: repos[0],
}));
const getArtifactWithRepository = mock(async () => ({
  art: { id: "a1", digest: "sha256:x" },
  repo: repos[0],
}));

mock.module("@hootifactory/auth", () => ({
  authorize: async (): Promise<Decision> => ({ allowed: orgAllowed }),
  createRequestAuthorizer:
    () => async (_action: string, resource: { type: string; repositoryId?: string }) => {
      if (resource.type === "org") return { allowed: orgAllowed };
      const repo = repos.find((r) => r.id === resource.repositoryId);
      return { allowed: repo ? perRepoAllowed(repo) : false };
    },
  httpStatusForDenial: () => 403,
}));
mock.module("@hootifactory/registry-platform/inventory", () => ({
  getArtifactWithRepository,
  getPackageWithRepository,
}));
mock.module("@hootifactory/registry-platform/repositories", () => ({
  countRepositoriesForOrg,
  getRepositoryById,
  listRepositoriesForOrg,
}));

const {
  artifactWithRepository,
  listAccessibleRepositories,
  packageWithRepository,
  repositoryById,
} = await import("./api-v1-access");

function context() {
  return {
    get: (key: string) =>
      key === "principal" ? { kind: "user", userId: "u1", username: "alice" } : undefined,
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  } as unknown as Context<AppEnv>;
}

describe("listAccessibleRepositories", () => {
  beforeEach(() => {
    orgAllowed = true;
    perRepoAllowed = () => true;
    countRepositoriesForOrg.mockClear();
    listRepositoriesForOrg.mockClear();
  });

  test("uses count + paginated list when the org is readable", async () => {
    const { rows, total } = await listAccessibleRepositories("org_1", context(), {
      limit: 2,
      offset: 0,
    });
    expect(total).toBe(3);
    expect(rows).toHaveLength(2);
    expect(countRepositoriesForOrg).toHaveBeenCalledTimes(1);
  });

  test("falls back to per-repo filtering when the org is not readable", async () => {
    orgAllowed = false;
    perRepoAllowed = (repo) => repo.visibility === "public";
    const { rows, total } = await listAccessibleRepositories("org_1", context(), {
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(["r1"]);
    expect(countRepositoriesForOrg).not.toHaveBeenCalled();
  });
});

describe("api v1 access data wrappers", () => {
  test("repositoryById delegates to getRepositoryById", async () => {
    expect((await repositoryById("r1"))?.id).toBe("r1");
  });

  test("packageWithRepository delegates to the inventory lookup", async () => {
    expect((await packageWithRepository("p1"))?.pkg.name).toBe("x");
  });

  test("artifactWithRepository delegates to the inventory lookup", async () => {
    expect((await artifactWithRepository("a1"))?.art.id).toBe("a1");
  });
});
