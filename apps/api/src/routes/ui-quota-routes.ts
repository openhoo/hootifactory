import { and, db, eq, isNull, quotas } from "@hootifactory/db";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { calculateOrgQuotaUsage, upsertOrgQuota } from "./ui-quota";
import { requireOrgAccess } from "./ui-repository-access";
import { QuotaBodySchema } from "./ui-schemas";

export function registerQuotaRoutes(router: Hono<AppEnv>): void {
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
}
