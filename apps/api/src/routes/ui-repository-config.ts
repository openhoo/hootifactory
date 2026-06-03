import { authorize } from "@hootifactory/auth";
import { db, eq, repositories } from "@hootifactory/db";
import { addUpstream, addVirtualMember } from "@hootifactory/registry-application";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { validateJsonBody } from "../validation";
import { audit } from "./http";
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

    const [memberCandidate] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, body.memberRepoId))
      .limit(1);
    const memberValidation = validateVirtualMemberCandidate(guard.repo, memberCandidate);
    if (!memberValidation.ok) {
      return c.json({ error: memberValidation.error }, memberValidation.status);
    }
    const { member } = memberValidation;
    const memberDecision = await authorize(c.get("principal"), "read", {
      type: "repository",
      orgId: member.orgId,
      repositoryId: member.id,
      repositoryName: member.name,
      visibility: member.visibility,
    });
    if (!memberDecision.allowed) {
      return c.json({ error: "member repository is not readable" }, 403);
    }

    await addVirtualMember(guard.repo.id, body.memberRepoId, body.position ?? 0);
    audit({
      orgId: guard.repo.orgId,
      action: "repository.member.add",
      result: "success",
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
    audit({
      orgId: guard.repo.orgId,
      action: "repository.upstream.add",
      result: "success",
      resourceType: "repository",
      resourceId: guard.repo.id,
      principal: c.get("principal"),
      detail: { url: body.url, priority: body.priority ?? 0 },
    });
    return c.json({ ok: true }, 201);
  });
}
