import {
  V1OkResponseSchema,
  V1QuotaRequestSchema,
  V1QuotaResponseSchema,
  V1RetentionRequestSchema,
  V1RetentionResponseSchema,
  V1ScanPolicyRequestSchema,
  V1ScanPolicyResponseSchema,
} from "@hootifactory/contracts";
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
import { isValidScanPolicyPattern } from "./ui-schemas";

export function registerApiV1PolicyRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.post(
    "/orgs/:orgId/scan-policies",
    doc({
      operationId: "upsertScanPolicy",
      summary: "Upsert a scan policy",
      tag: "Policies",
      description: "Creates or replaces the scan policy for a repository pattern.",
      pathParams: OrgIdParamsSchema,
      requestBody: {
        description: "Scan policy settings.",
        schema: V1ScanPolicyRequestSchema,
      },
      response: {
        status: 201,
        description: "Scan policy upserted.",
        schema: V1ScanPolicyResponseSchema,
      },
    }),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const policyResponse = await authorizePolicy(c, {
        orgId: params.data.orgId,
        policy: "scan",
        action: "admin",
      });
      if (policyResponse) return policyResponse;
      const parsedBody = await validateJsonV1(
        c,
        V1ScanPolicyRequestSchema,
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

  apiV1Router.get(
    "/orgs/:orgId/quota",
    doc({
      operationId: "getOrganizationQuota",
      summary: "Get org quota",
      tag: "Policies",
      description: "Gets storage and artifact quota limits and current usage for an organization.",
      pathParams: OrgIdParamsSchema,
      response: { description: "Organization quota state.", schema: V1QuotaResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const policyResponse = await authorizePolicy(c, {
        orgId: params.data.orgId,
        policy: "quota",
        action: "read",
      });
      if (policyResponse) return policyResponse;
      return dataResponse(c, await getOrgQuota(params.data.orgId));
    },
  );

  apiV1Router.post(
    "/orgs/:orgId/quota",
    doc({
      operationId: "setOrganizationQuota",
      summary: "Set org quota",
      tag: "Policies",
      description: "Sets organization quota limits. Omitted or null limits are unlimited.",
      pathParams: OrgIdParamsSchema,
      requestBody: { description: "Quota limits.", schema: V1QuotaRequestSchema },
      response: { description: "Quota updated.", schema: V1OkResponseSchema },
    }),
    async (c) => {
      const params = validateV1(c, OrgIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const policyResponse = await authorizePolicy(c, {
        orgId: params.data.orgId,
        policy: "quota",
        action: "write",
      });
      if (policyResponse) return policyResponse;
      const parsedBody = await validateJsonV1(c, V1QuotaRequestSchema, "invalid quota request");
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
    },
  );

  apiV1Router.post(
    "/repositories/:repoId/retention/apply",
    doc({
      operationId: "applyRepositoryRetention",
      summary: "Apply retention",
      tag: "Policies",
      description: "Applies retention pruning to one repository.",
      pathParams: RepoIdParamsSchema,
      requestBody: {
        description: "Retention application options.",
        schema: V1RetentionRequestSchema,
      },
      response: { description: "Retention result.", schema: V1RetentionResponseSchema },
    }),
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
      const parsedBody = await validateJsonV1(
        c,
        V1RetentionRequestSchema,
        "invalid retention request",
      );
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
