import {
  and,
  count,
  db,
  desc,
  eq,
  isNull,
  packages,
  packageVersions,
  repositories,
} from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateParams } from "../validation";
import { repositoryDto } from "./ui-dto";
import {
  requireReadableParentRepo,
  requireRepositoryAccessFromParam,
} from "./ui-repository-access";

export function registerContentRoutes(router: Hono<AppEnv>): void {
  router.get("/repositories/:repoId", async (c) => {
    const access = await requireRepositoryAccessFromParam(c, "read");
    if (!access.ok) return access.response;
    const { repo } = access;
    const countRows = await db
      .select({ value: count() })
      .from(packages)
      .where(eq(packages.repositoryId, repo.id));
    return c.json({ repository: repositoryDto(repo), packageCount: countRows[0]?.value ?? 0 });
  });

  router.get("/repositories/:repoId/packages", async (c) => {
    const access = await requireRepositoryAccessFromParam(c, "read");
    if (!access.ok) return access.response;
    const { repo } = access;
    const rows = await db
      .select({ id: packages.id, name: packages.name, latestVersion: packages.latestVersion })
      .from(packages)
      .where(eq(packages.repositoryId, repo.id))
      .orderBy(packages.name);
    return c.json({ packages: rows });
  });

  router.get("/packages/:packageId/versions", async (c) => {
    const parsedParams = validateParams(c, uuidParams.packageId);
    if (!parsedParams.ok) return parsedParams.response;
    const { packageId } = parsedParams.data;
    const [row] = await db
      .select({ pkg: packages, repo: repositories })
      .from(packages)
      .innerJoin(repositories, eq(packages.repositoryId, repositories.id))
      .where(eq(packages.id, packageId))
      .limit(1);
    const pkg = row?.pkg;
    const repo = row?.repo;
    const denied = await requireReadableParentRepo(c, repo, "package not found");
    if (denied) return denied;
    // unreachable at runtime (innerJoin); retained for type narrowing
    if (!pkg) return c.json({ error: "package not found" }, 404);
    const rows = await db
      .select({
        version: packageVersions.version,
        sizeBytes: packageVersions.sizeBytes,
        createdAt: packageVersions.createdAt,
      })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)))
      .orderBy(desc(packageVersions.createdAt));
    return c.json({ package: { id: pkg.id, name: pkg.name }, versions: rows });
  });
}
