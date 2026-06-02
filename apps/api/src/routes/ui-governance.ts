import { applyRetention } from "@hootifactory/core";
import {
  and,
  artifacts,
  db,
  desc,
  eq,
  findings,
  isNull,
  quotas,
  repositories,
  scanPolicies,
} from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { calculateOrgQuotaUsage, upsertOrgQuota } from "./ui-quota";
import {
  requireOrgAccess,
  requireReadableParentRepo,
  requireRepositoryAccessFromParam,
} from "./ui-repository-access";
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
    const denied = await requireOrgAccess(c, orgId, "admin");
    if (denied) return denied;
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
    audit({
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
    });
    return c.json({ policy: row }, 201);
  });

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

  router.get("/orgs/:orgId/quota", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const denied = await requireOrgAccess(c, orgId, "read");
    if (denied) return denied;
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
    const denied = await requireOrgAccess(c, orgId, "admin");
    if (denied) return denied;
    const parsedBody = await validateJsonBody(c, QuotaBodySchema, "invalid quota request");
    if (!parsedBody.ok) return parsedBody.response;
    const maxStorageBytes = parsedBody.data.maxStorageBytes ?? null;
    const maxArtifacts = parsedBody.data.maxArtifacts ?? null;
    const usage = await calculateOrgQuotaUsage(orgId);
    await upsertOrgQuota(orgId, { maxStorageBytes, maxArtifacts }, usage);
    audit({
      orgId,
      action: "quota.set",
      result: "success",
      resourceType: "quota",
      principal: c.get("principal"),
      detail: { maxStorageBytes },
    });
    return c.json({ ok: true });
  });

  router.post("/repositories/:repoId/retention/apply", async (c) => {
    const guard = await requireRepositoryAccessFromParam(c, "admin");
    if (!guard.ok) return guard.response;
    const parsedBody = await validateJsonBody(c, RetentionBodySchema, "invalid retention request");
    if (!parsedBody.ok) return parsedBody.response;
    const { keepLastN } = parsedBody.data;
    const pruned = await applyRetention(guard.repo.id, keepLastN);
    audit({
      orgId: guard.repo.orgId,
      action: "retention.apply",
      result: "success",
      resourceType: "repository",
      resourceId: guard.repo.id,
      principal: c.get("principal"),
      detail: { keepLastN, pruned },
    });
    return c.json({ pruned });
  });
}
