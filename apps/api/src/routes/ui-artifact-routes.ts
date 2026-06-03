import {
  getArtifactWithRepository,
  listArtifactFindings,
  listRepositoryArtifactSummaries,
} from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateParams } from "../validation";
import {
  requireReadableParentRepo,
  requireRepositoryAccessFromParam,
} from "./ui-repository-access";

export function registerArtifactRoutes(router: Hono<AppEnv>): void {
  router.get("/repositories/:repoId/artifacts", async (c) => {
    const access = await requireRepositoryAccessFromParam(c, "read");
    if (!access.ok) return access.response;
    const { repo } = access;
    const rows = await listRepositoryArtifactSummaries(repo.id);
    return c.json({
      artifacts: rows.map(({ createdAt: _createdAt, ...artifact }) => artifact),
    });
  });

  router.get("/artifacts/:artifactId/findings", async (c) => {
    const parsedParams = validateParams(c, uuidParams.artifactId);
    if (!parsedParams.ok) return parsedParams.response;
    const { artifactId } = parsedParams.data;
    const row = await getArtifactWithRepository(artifactId);
    const art = row?.art;
    const repo = row?.repo;
    const denied = await requireReadableParentRepo(c, repo, "artifact not found");
    if (denied) return denied;
    // unreachable at runtime (innerJoin); retained for type narrowing
    if (!art) return c.json({ error: "artifact not found" }, 404);
    const rows = await listArtifactFindings(art.id);
    return c.json({ findings: rows });
  });
}
