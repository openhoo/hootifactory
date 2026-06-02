import { artifacts, db, desc, eq, findings, repositories } from "@hootifactory/db";
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
    const rows = await db
      .select({
        id: artifacts.id,
        digest: artifacts.digest,
        name: artifacts.name,
        version: artifacts.version,
        state: artifacts.state,
        policyDecision: artifacts.policyDecision,
      })
      .from(artifacts)
      .where(eq(artifacts.repositoryId, repo.id))
      .orderBy(desc(artifacts.createdAt));
    return c.json({ artifacts: rows });
  });

  router.get("/artifacts/:artifactId/findings", async (c) => {
    const parsedParams = validateParams(c, uuidParams.artifactId);
    if (!parsedParams.ok) return parsedParams.response;
    const { artifactId } = parsedParams.data;
    const [row] = await db
      .select({ art: artifacts, repo: repositories })
      .from(artifacts)
      .innerJoin(repositories, eq(artifacts.repositoryId, repositories.id))
      .where(eq(artifacts.id, artifactId))
      .limit(1);
    const art = row?.art;
    const repo = row?.repo;
    const denied = await requireReadableParentRepo(c, repo, "artifact not found");
    if (denied) return denied;
    // unreachable at runtime (innerJoin); retained for type narrowing
    if (!art) return c.json({ error: "artifact not found" }, 404);
    const rows = await db
      .select({
        vulnId: findings.vulnId,
        type: findings.type,
        severity: findings.severity,
        packageName: findings.packageName,
        packageVersion: findings.packageVersion,
        fixedVersion: findings.fixedVersion,
        title: findings.title,
      })
      .from(findings)
      .where(eq(findings.artifactId, art.id));
    return c.json({ findings: rows });
  });
}
