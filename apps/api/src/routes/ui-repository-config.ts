import { authorize } from "@hootifactory/auth";
import {
  addUpstream,
  addVirtualMember,
  getRepositoryById,
  VirtualMemberLimitExceededError,
  VirtualMemberOrgMismatchError,
} from "@hootifactory/registry-platform/repositories";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { validateJsonBody } from "../validation";
import { AUDIT_RESULT, audit } from "./http";
import { requireRepositoryAccessFromParam } from "./ui-repository-access";
import { AddMemberBodySchema, AddUpstreamBodySchema } from "./ui-schemas";
import { validateProxyUpstreamParent, validateProxyUpstreamUrl } from "./ui-upstreams";
import { validateVirtualMemberCandidate, validateVirtualMemberParent } from "./ui-virtual-members";

export function registerRepositoryConfigRoutes(router: Hono<AppEnv>): void {
  router.post("/repositories/:repoId/members", async (c) => {
    const guard = await requireRepositoryAccessFromParam(c, "admin");
    if (!guard.ok) return guard.response;
    const parentValidation = validateVirtualMemberParent(guard.repo);
    if (!parentValidation.ok) {
      return c.json({ error: parentValidation.error }, parentValidation.status);
    }
    const parsedBody = await validateJsonBody(c, AddMemberBodySchema, "invalid member request");
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;

    const memberCandidate = await getRepositoryById(body.memberRepoId);
    // Authorize read on the candidate before any attribute-revealing validation so the
    // endpoint cannot be used as an existence/module/kind oracle for repos the caller
    // cannot read: a missing repo and an unreadable repo are indistinguishable (404).
    const memberNotFound = c.json({ error: "member repository not found" }, 404);
    if (!memberCandidate) return memberNotFound;
    const memberDecision = await authorize(c.get("principal"), "read", {
      type: "repository",
      orgId: memberCandidate.orgId,
      repositoryId: memberCandidate.id,
      repositoryName: memberCandidate.name,
      visibility: memberCandidate.visibility,
    });
    if (!memberDecision.allowed) return memberNotFound;
    const memberValidation = validateVirtualMemberCandidate(guard.repo, memberCandidate);
    if (!memberValidation.ok) {
      return c.json({ error: memberValidation.error }, memberValidation.status);
    }
    const { member } = memberValidation;

    try {
      await addVirtualMember(guard.repo.id, body.memberRepoId, body.position ?? 0);
    } catch (err) {
      if (
        err instanceof VirtualMemberLimitExceededError ||
        err instanceof VirtualMemberOrgMismatchError
      ) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    audit(c, {
      orgId: guard.repo.orgId,
      action: "repository.member.add",
      result: AUDIT_RESULT.success,
      resourceType: "repository",
      resourceId: guard.repo.id,
      principal: c.get("principal"),
      detail: { memberRepoId: member.id, memberName: member.name, position: body.position ?? 0 },
    });
    return c.json({ ok: true }, 201);
  });

  router.post("/repositories/:repoId/upstreams", async (c) => {
    const guard = await requireRepositoryAccessFromParam(c, "admin");
    if (!guard.ok) return guard.response;
    const parentValidation = validateProxyUpstreamParent(guard.repo);
    if (!parentValidation.ok) {
      return c.json({ error: parentValidation.error }, parentValidation.status);
    }
    const parsedBody = await validateJsonBody(c, AddUpstreamBodySchema, "invalid upstream request");
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;
    const upstreamUrl = validateProxyUpstreamUrl(body.url);
    if (!upstreamUrl.ok) {
      return c.json({ error: upstreamUrl.error }, upstreamUrl.status);
    }
    await addUpstream(guard.repo.id, upstreamUrl.url, body.priority ?? 0);
    audit(c, {
      orgId: guard.repo.orgId,
      action: "repository.upstream.add",
      result: AUDIT_RESULT.success,
      resourceType: "repository",
      resourceId: guard.repo.id,
      principal: c.get("principal"),
      detail: { url: body.url, priority: body.priority ?? 0 },
    });
    return c.json({ ok: true }, 201);
  });
}
