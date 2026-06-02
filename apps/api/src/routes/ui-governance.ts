import { applyRetention } from "@hootifactory/core";
import { db, scanPolicies } from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { registerArtifactRoutes } from "./ui-artifact-routes";
import { registerQuotaRoutes } from "./ui-quota-routes";
import { requireOrgAccess, requireRepositoryAccessFromParam } from "./ui-repository-access";
import { isValidScanPolicyPattern, RetentionBodySchema, ScanPolicyBodySchema } from "./ui-schemas";

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

  registerArtifactRoutes(router);
  registerQuotaRoutes(router);

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
