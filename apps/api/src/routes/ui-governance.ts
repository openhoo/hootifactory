import { applyRetention } from "@hootifactory/core";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { validateJsonBody } from "../validation";
import { audit } from "./http";
import { registerArtifactRoutes } from "./ui-artifact-routes";
import { registerQuotaRoutes } from "./ui-quota-routes";
import { requireRepositoryAccessFromParam } from "./ui-repository-access";
import { registerScanPolicyRoutes } from "./ui-scan-policy-routes";
import { RetentionBodySchema } from "./ui-schemas";

export function registerGovernanceRoutes(router: Hono<AppEnv>): void {
  registerScanPolicyRoutes(router);
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
