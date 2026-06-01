import { authorize, writeAudit } from "@hootifactory/auth";
import { applyRetention } from "@hootifactory/core";
import {
  and,
  artifacts,
  blobRefs,
  blobs,
  count,
  db,
  desc,
  eq,
  findings,
  isNull,
  packageVersions,
  quotas,
  repositories,
  scanPolicies,
  sql,
} from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { authorizeRepository, requireRepositoryAccess } from "./ui-repository-access";
import {
  isValidScanPolicyPattern,
  QuotaBodySchema,
  RetentionBodySchema,
  ScanPolicyBodySchema,
} from "./ui-schemas";

export function registerGovernanceRoutes(router: Hono<AppEnv>): void {
  router.post("/orgs/:orgId/scan-policies", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
    if (!decision.allowed) {
      return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
    }
    const parsedBody = await validateJsonBody(
      c,
      ScanPolicyBodySchema,
      "invalid scan policy request",
    );
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;
    const repositoryPattern = body.repositoryPattern ?? "*";
    if (!isValidScanPolicyPattern(repositoryPattern)) {
      return c.json(
        {
          error:
            "repository pattern must use repository-name characters plus '*' wildcards, or '*' for all repositories",
        },
        400,
      );
    }
    const blockOnSeverity = body.blockOnSeverity ?? null;
    const [row] = await db
      .insert(scanPolicies)
      .values({
        orgId,
        repositoryPattern,
        mode: body.mode,
        blockOnSeverity,
      })
      .onConflictDoUpdate({
        target: [scanPolicies.orgId, scanPolicies.repositoryPattern],
        set: {
          mode: body.mode,
          blockOnSeverity,
          updatedAt: new Date(),
        },
      })
      .returning();
    void writeAudit({
      orgId,
      action: "scan_policy.create",
      result: "success",
      resourceType: "scan_policy",
      resourceId: row?.id,
      principal: c.get("principal"),
      detail: {
        repositoryPattern,
        mode: body.mode,
        blockOnSeverity,
      },
    }).catch(() => {});
    return c.json({ policy: row }, 201);
  });

  router.get("/repositories/:repoId/artifacts", async (c) => {
    const parsedParams = validateParams(c, uuidParams.repoId);
    if (!parsedParams.ok) return parsedParams.response;
    const { repoId } = parsedParams.data;
    const access = await requireRepositoryAccess(c, repoId, "read");
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
    if (!art || !repo) return c.json({ error: "artifact not found" }, 404);
    const denied = await authorizeRepository(c, "read", repo);
    if (denied) return denied;
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

  router.get("/orgs/:orgId/quota", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const decision = await authorize(c.get("principal"), "read", { type: "org", orgId });
    if (!decision.allowed) {
      return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
    }
    const [q] = await db
      .select()
      .from(quotas)
      .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
      .limit(1);
    return c.json({
      maxStorageBytes: q?.maxStorageBytes ?? null,
      usedStorageBytes: q?.usedStorageBytes ?? 0,
    });
  });

  router.post("/orgs/:orgId/quota", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
    if (!decision.allowed) {
      return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
    }
    const parsedBody = await validateJsonBody(c, QuotaBodySchema, "invalid quota request");
    if (!parsedBody.ok) return parsedBody.response;
    const maxStorageBytes = parsedBody.data.maxStorageBytes ?? null;
    const maxArtifacts = parsedBody.data.maxArtifacts ?? null;
    const [agg] = await db
      .select({ used: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
      .from(blobs)
      .where(
        sql`${blobs.digest} in (select distinct ${blobRefs.digest} from ${blobRefs} join ${repositories} on ${blobRefs.repositoryId} = ${repositories.id} where ${repositories.orgId} = ${orgId})`,
      );
    const [artifactAgg] = await db
      .select({ used: count() })
      .from(packageVersions)
      .where(eq(packageVersions.orgId, orgId));
    const usedStorageBytes = Number(agg?.used ?? 0);
    const usedArtifacts = artifactAgg?.used ?? 0;
    const [existing] = await db
      .select({ id: quotas.id })
      .from(quotas)
      .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
      .limit(1);
    if (existing) {
      await db
        .update(quotas)
        .set({ maxStorageBytes, maxArtifacts, usedStorageBytes, usedArtifacts })
        .where(eq(quotas.id, existing.id));
    } else {
      await db.insert(quotas).values({
        orgId,
        maxStorageBytes,
        maxArtifacts,
        usedStorageBytes,
        usedArtifacts,
      });
    }
    void writeAudit({
      orgId,
      action: "quota.set",
      result: "success",
      resourceType: "quota",
      principal: c.get("principal"),
      detail: { maxStorageBytes },
    }).catch(() => {});
    return c.json({ ok: true });
  });

  router.post("/repositories/:repoId/retention/apply", async (c) => {
    const parsedParams = validateParams(c, uuidParams.repoId);
    if (!parsedParams.ok) return parsedParams.response;
    const guard = await requireRepositoryAccess(c, parsedParams.data.repoId, "admin");
    if (!guard.ok) return guard.response;
    const parsedBody = await validateJsonBody(c, RetentionBodySchema, "invalid retention request");
    if (!parsedBody.ok) return parsedBody.response;
    const { keepLastN } = parsedBody.data;
    const pruned = await applyRetention(guard.repo.id, keepLastN);
    void writeAudit({
      orgId: guard.repo.orgId,
      action: "retention.apply",
      result: "success",
      resourceType: "repository",
      resourceId: guard.repo.id,
      principal: c.get("principal"),
      detail: { keepLastN, pruned },
    }).catch(() => {});
    return c.json({ pruned });
  });
}
