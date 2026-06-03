import {
  addUpstream,
  addVirtualMember,
  getRepositoryById,
} from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import {
  authorizeRepository,
  dataResponse,
  doc,
  errorResponse,
  RepoIdParamsSchema,
  requireRepository,
  validateJsonV1,
  validateV1,
} from "./api-v1-helpers";
import { audit } from "./http";
import { AddMemberBodySchema, AddUpstreamBodySchema } from "./ui-schemas";
import { validateProxyUpstreamParent, validateProxyUpstreamUrl } from "./ui-upstreams";
import { validateVirtualMemberCandidate, validateVirtualMemberParent } from "./ui-virtual-members";

export function registerApiV1RepositoryConfigRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.post(
    "/repositories/:repoId/upstreams",
    doc("Add a proxy upstream", "Repositories"),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const access = await requireRepository(c, params.data.repoId, "admin");
      if (!access.ok) return access.response;
      const parentValidation = validateProxyUpstreamParent(access.repo);
      if (!parentValidation.ok) {
        return errorResponse(c, parentValidation.status, "BAD_REQUEST", parentValidation.error);
      }
      const parsedBody = await validateJsonV1(c, AddUpstreamBodySchema, "invalid upstream request");
      if (!parsedBody.ok) return parsedBody.response;
      const upstreamUrl = validateProxyUpstreamUrl(parsedBody.data.url);
      if (!upstreamUrl.ok) {
        return errorResponse(c, upstreamUrl.status, "BAD_REQUEST", upstreamUrl.error);
      }
      await addUpstream(access.repo.id, upstreamUrl.url, parsedBody.data.priority ?? 0);
      audit({
        orgId: access.repo.orgId,
        action: "repository.upstream.add",
        result: "success",
        resourceType: "repository",
        resourceId: access.repo.id,
        principal: c.get("principal"),
        detail: { url: parsedBody.data.url, priority: parsedBody.data.priority ?? 0 },
      });
      return dataResponse(c, { ok: true }, 201);
    },
  );

  apiV1Router.post(
    "/repositories/:repoId/members",
    doc("Add a virtual repository member", "Repositories"),
    async (c) => {
      const params = validateV1(c, RepoIdParamsSchema, c.req.param(), "invalid path parameters");
      if (!params.ok) return params.response;
      const access = await requireRepository(c, params.data.repoId, "admin");
      if (!access.ok) return access.response;
      const parentValidation = validateVirtualMemberParent(access.repo);
      if (!parentValidation.ok) {
        return errorResponse(c, parentValidation.status, "BAD_REQUEST", parentValidation.error);
      }
      const parsedBody = await validateJsonV1(c, AddMemberBodySchema, "invalid member request");
      if (!parsedBody.ok) return parsedBody.response;
      const memberCandidate = await getRepositoryById(parsedBody.data.memberRepoId);
      const memberValidation = validateVirtualMemberCandidate(access.repo, memberCandidate);
      if (!memberValidation.ok) {
        return errorResponse(c, memberValidation.status, "BAD_REQUEST", memberValidation.error);
      }
      const memberResponse = await authorizeRepository(c, memberValidation.member, "read");
      if (memberResponse) return memberResponse;
      await addVirtualMember(
        access.repo.id,
        parsedBody.data.memberRepoId,
        parsedBody.data.position ?? 0,
      );
      audit({
        orgId: access.repo.orgId,
        action: "repository.member.add",
        result: "success",
        resourceType: "repository",
        resourceId: access.repo.id,
        principal: c.get("principal"),
        detail: {
          memberRepoId: memberValidation.member.id,
          position: parsedBody.data.position ?? 0,
        },
      });
      return dataResponse(c, { ok: true }, 201);
    },
  );
}
