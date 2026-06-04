import {
  countLivePackageVersions,
  countRepositoryPackages,
  getPackageWithRepository,
  listLivePackageVersionSummaries,
  listRepositoryPackageSummaries,
} from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateInput, validateParams } from "../validation";
import { repositoryDto } from "./ui-dto";
import {
  requireReadableParentRepo,
  requireRepositoryAccessFromParam,
} from "./ui-repository-access";
import { PaginationQuerySchema } from "./ui-schemas";

export function registerContentRoutes(router: Hono<AppEnv>): void {
  router.get("/repositories/:repoId", async (c) => {
    const access = await requireRepositoryAccessFromParam(c, "read");
    if (!access.ok) return access.response;
    const { repo } = access;
    return c.json({
      repository: repositoryDto(repo),
      packageCount: await countRepositoryPackages(repo.id),
    });
  });

  router.get("/repositories/:repoId/packages", async (c) => {
    const access = await requireRepositoryAccessFromParam(c, "read");
    if (!access.ok) return access.response;
    const pagination = validateInput(c, PaginationQuerySchema, c.req.query(), "invalid pagination");
    if (!pagination.ok) return pagination.response;
    const { repo } = access;
    const [total, rows] = await Promise.all([
      countRepositoryPackages(repo.id),
      listRepositoryPackageSummaries(repo.id, pagination.data),
    ]);
    return c.json({ packages: rows, pagination: { ...pagination.data, total } });
  });

  router.get("/packages/:packageId/versions", async (c) => {
    const parsedParams = validateParams(c, uuidParams.packageId);
    if (!parsedParams.ok) return parsedParams.response;
    const { packageId } = parsedParams.data;
    const row = await getPackageWithRepository(packageId);
    const pkg = row?.pkg;
    const repo = row?.repo;
    const denied = await requireReadableParentRepo(c, repo, "package not found");
    if (denied) return denied;
    // unreachable at runtime (innerJoin); retained for type narrowing
    if (!pkg) return c.json({ error: "package not found" }, 404);
    const pagination = validateInput(c, PaginationQuerySchema, c.req.query(), "invalid pagination");
    if (!pagination.ok) return pagination.response;
    const [total, rows] = await Promise.all([
      countLivePackageVersions(pkg.id),
      listLivePackageVersionSummaries(pkg.id, pagination.data),
    ]);
    return c.json({
      package: { id: pkg.id, name: pkg.name },
      versions: rows,
      pagination: { ...pagination.data, total },
    });
  });
}
