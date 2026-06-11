import { getOrgQuota, setOrgQuota } from "@hootifactory/registry-platform/governance";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { AUDIT_RESULT, audit } from "./http";
import { requireOrgAccess } from "./ui-repository-access";
import { QuotaBodySchema } from "./ui-schemas";

export function registerQuotaRoutes(router: Hono<AppEnv>): void {
  router.get("/orgs/:orgId/quota", async (c) => {
    const parsedParams = validateParams(c, uuidParams.orgId);
    if (!parsedParams.ok) return parsedParams.response;
    const { orgId } = parsedParams.data;
    const denied = await requireOrgAccess(c, orgId, "read");
    if (denied) return denied;
    const q = await getOrgQuota(orgId);
    return c.json({
      maxStorageBytes: q.maxStorageBytes,
      usedStorageBytes: q.usedStorageBytes,
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
    await setOrgQuota(orgId, { maxStorageBytes, maxArtifacts });
    audit(c, {
      orgId,
      action: "quota.set",
      result: AUDIT_RESULT.success,
      resourceType: "quota",
      principal: c.get("principal"),
      detail: { maxStorageBytes },
    });
    return c.json({ ok: true });
  });
}
