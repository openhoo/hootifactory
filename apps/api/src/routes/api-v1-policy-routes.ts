import {
  applyRetention,
  getOrgQuota,
  setOrgQuota,
  upsertScanPolicy,
} from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  authorizePolicy,
  dataResponse,
  doc,
  errorResponse,
  OrgIdParamsSchema,
  RepoIdParamsSchema,
  repositoryById,
  validateJsonV1,
  validateV1,
} from "./api-v1-helpers";
import { audit } from "./http";
import {
  isValidScanPolicyPattern,
  QuotaBodySchema,
  RetentionBodySchema,
  ScanPolicyBodySchema,
} from "./ui-schemas";

export function registerApiV1PolicyRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.post(
    "/orgs/:orgId/scan-policies",
    doc("Upsert a scan policy", "Policies"),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const policyResponse = await authorizePolicy(c, {
        orgId: params.data.orgId,
        policy: "scan",
        action: "write",
      });
      if (policyResponse) return policyResponse;
      const parsedBody = await validateJsonV1(
        c,
        ScanPolicyBodySchema,
        "invalid scan policy request",
      );
      if (!parsedBody.ok) return parsedBody.response;
      const repositoryPattern = parsedBody.data.repositoryPattern ?? "*";
      if (!isValidScanPolicyPattern(repositoryPattern)) {
        return errorResponse(
          c,
          400,
          "BAD_REQUEST",
          "repository pattern must use repository-name characters plus '*' wildcards, or '*' for all repositories",
        );
      }
      const row = await upsertScanPolicy({
        orgId: params.data.orgId,
        repositoryPattern,
        mode: parsedBody.data.mode,
        blockOnSeverity: parsedBody.data.blockOnSeverity ?? null,
      });
      audit({
        orgId: params.data.orgId,
        action: "scan_policy.create",
        result: "success",
        resourceType: "scan_policy",
        resourceId: row?.id,
        principal: c.get("principal"),
        detail: { repositoryPattern, mode: parsedBody.data.mode },
      });
      return dataResponse(c, row, 201);
    },
  );

  apiV1Router.get("/orgs/:orgId/quota", doc("Get org quota", "Policies"), async (c) => {
    const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const policyResponse = await authorizePolicy(c, {
      orgId: params.data.orgId,
      policy: "quota",
      action: "read",
    });
    if (policyResponse) return policyResponse;
    return dataResponse(c, await getOrgQuota(params.data.orgId));
  });

  apiV1Router.post("/orgs/:orgId/quota", doc("Set org quota", "Policies"), async (c) => {
    const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
    if (!params.ok) return params.response;
    const policyResponse = await authorizePolicy(c, {
      orgId: params.data.orgId,
      policy: "quota",
      action: "write",
    });
    if (policyResponse) return policyResponse;
    const parsedBody = await validateJsonV1(c, QuotaBodySchema, "invalid quota request");
    if (!parsedBody.ok) return parsedBody.response;
    await setOrgQuota(params.data.orgId, {
      maxStorageBytes: parsedBody.data.maxStorageBytes ?? null,
      maxArtifacts: parsedBody.data.maxArtifacts ?? null,
    });
    audit({
      orgId: params.data.orgId,
      action: "quota.set",
      result: "success",
      resourceType: "quota",
      principal: c.get("principal"),
    });
    return dataResponse(c, { ok: true });
  });

  apiV1Router.post(
    "/repositories/:repoId/retention/apply",
    doc("Apply retention", "Policies"),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const repo = await repositoryById(params.data.repoId);
      if (!repo) return errorResponse(c, 404, "NOT_FOUND", "repository not found");
      const policyResponse = await authorizePolicy(c, {
        orgId: repo.orgId,
        repo,
        policy: "retention",
        action: "write",
      });
      if (policyResponse) return policyResponse;
      const parsedBody = await validateJsonV1(c, RetentionBodySchema, "invalid retention request");
      if (!parsedBody.ok) return parsedBody.response;
      const pruned = await applyRetention(repo.id, parsedBody.data.keepLastN);
      audit({
        orgId: repo.orgId,
        action: "retention.apply",
        result: "success",
        resourceType: "repository",
        resourceId: repo.id,
        principal: c.get("principal"),
        detail: { keepLastN: parsedBody.data.keepLastN, pruned },
      });
      return dataResponse(c, { pruned });
    },
  );
}
