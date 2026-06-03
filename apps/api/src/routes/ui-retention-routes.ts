import { applyRetention } from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { validateJsonBody } from "../validation";
import { audit } from "./http";
import { requireRepositoryAccessFromParam } from "./ui-repository-access";
import { RetentionBodySchema } from "./ui-schemas";

export function registerRetentionRoutes(router: Hono<AppEnv>): void {
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
