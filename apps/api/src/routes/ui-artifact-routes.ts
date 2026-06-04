import {
  countArtifactFindings,
  countRepositoryArtifacts,
  getArtifactWithRepository,
  listArtifactFindings,
  listRepositoryArtifactSummaries,
} from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateInput, validateParams } from "../validation";
import {
  requireRepositoryAccessFromParam,
  requireScanFindingsAccess,
} from "./ui-repository-access";
import { FindingListQuerySchema, PaginationQuerySchema } from "./ui-schemas";

export function registerArtifactRoutes(router: Hono<AppEnv>): void {
  router.get("/repositories/:repoId/artifacts", async (c) => {
    const access = await requireRepositoryAccessFromParam(c, "read");
    if (!access.ok) return access.response;
    const pagination = validateInput(c, PaginationQuerySchema, c.req.query(), "invalid pagination");
    if (!pagination.ok) return pagination.response;
    const { repo } = access;
    const [total, rows] = await Promise.all([
      countRepositoryArtifacts(repo.id),
      listRepositoryArtifactSummaries(repo.id, pagination.data),
    ]);
    return c.json({
      artifacts: rows.map(({ createdAt: _createdAt, ...artifact }) => artifact),
      pagination: { ...pagination.data, total },
    });
  });

  router.get("/artifacts/:artifactId/findings", async (c) => {
    const parsedParams = validateParams(c, uuidParams.artifactId);
    if (!parsedParams.ok) return parsedParams.response;
    const { artifactId } = parsedParams.data;
    const row = await getArtifactWithRepository(artifactId);
    const art = row?.art;
    const repo = row?.repo;
    const denied = await requireScanFindingsAccess(c, repo, "artifact not found");
    if (denied) return denied;
    // unreachable at runtime (innerJoin); retained for type narrowing
    if (!art) return c.json({ error: "artifact not found" }, 404);
    const query = validateInput(c, FindingListQuerySchema, c.req.query(), "invalid findings query");
    if (!query.ok) return query.response;
    const [total, rows] = await Promise.all([
      countArtifactFindings(art.id, { severity: query.data.severity }),
      listArtifactFindings(art.id, query.data),
    ]);
    return c.json({
      findings: rows,
      pagination: { limit: query.data.limit, offset: query.data.offset, total },
    });
  });
}
