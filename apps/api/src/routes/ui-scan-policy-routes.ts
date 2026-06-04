import { upsertScanPolicy } from "@hootifactory/registry-application/governance";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { requireOrgAccess } from "./ui-repository-access";
import { isValidScanPolicyPattern, ScanPolicyBodySchema } from "./ui-schemas";

export function registerScanPolicyRoutes(router: Hono<AppEnv>): void {
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
    const row = await upsertScanPolicy({
      orgId,
      repositoryPattern,
      mode: body.mode,
      blockOnSeverity,
    });
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
}
