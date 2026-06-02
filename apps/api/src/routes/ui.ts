import { authorize } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  addUpstream,
  addVirtualMember,
  createRepository,
  isUniqueViolation,
} from "@hootifactory/core";
import { db, eq, memberships, organizations, repositories } from "@hootifactory/db";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { audit } from "./http";
import { registerContentRoutes } from "./ui-content";
import { repositoryDto } from "./ui-dto";
import { registerGovernanceRoutes } from "./ui-governance";
import { listAccessibleOrgs } from "./ui-orgs";
import {
  requireOrgAccess,
  requireRepositoryAccessFromParam,
  requireUserPrincipal,
} from "./ui-repository-access";
import { resolveCreateRepositoryRequest } from "./ui-repository-create";
import {
  AddMemberBodySchema,
  AddUpstreamBodySchema,
  CreateOrgBodySchema,
  CreateRepositoryBodySchema,
} from "./ui-schemas";
import { registerTokenRoutes } from "./ui-tokens";
import { validateProxyUpstreamParent, validateProxyUpstreamUrl } from "./ui-upstreams";
import { validateVirtualMemberCandidate, validateVirtualMemberParent } from "./ui-virtual-members";

export const uiRouter = new Hono<AppEnv>();

uiRouter.get("/me", (c) => {
  const p = c.get("principal");
  if (p.kind === "anonymous") return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, principal: p });
});

uiRouter.get("/orgs", async (c) => {
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ orgs: [] });
  return c.json({ orgs: await listAccessibleOrgs(p.userId) });
});

uiRouter.post("/orgs", async (c) => {
  if (!env.AUTH_ALLOW_ORG_CREATION) {
    return c.json({ error: "org creation is disabled" }, 403);
  }
  const user = requireUserPrincipal(c);
  if (!user.ok) return user.response;
  const p = user.principal;
  const parsedBody = await validateJsonBody(c, CreateOrgBodySchema, "invalid org request");
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const [org] = await db
      .insert(organizations)
      .values({ slug: body.slug, displayName: body.displayName, description: body.description })
      .returning();
    if (!org) return c.json({ error: "failed to create org" }, 500);
    await db.insert(memberships).values({ orgId: org.id, userId: p.userId, role: "owner" });
    audit({
      orgId: org.id,
      action: "org.create",
      result: "success",
      resourceType: "org",
      resourceId: org.id,
      principal: p,
      detail: { slug: org.slug },
    });
    return c.json({ org }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: `org slug '${body.slug}' already taken` }, 409);
    }
    throw err;
  }
});

uiRouter.get("/orgs/:orgId/repositories", async (c) => {
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const denied = await requireOrgAccess(c, orgId, "read");
  if (denied) return denied;
  const rows = await db.select().from(repositories).where(eq(repositories.orgId, orgId));
  return c.json({ repositories: rows.map(repositoryDto) });
});

registerContentRoutes(uiRouter);

// ── proxy/virtual configuration ──────────────────────────────────────────
uiRouter.post("/repositories/:repoId/members", async (c) => {
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

uiRouter.post("/repositories/:repoId/upstreams", async (c) => {
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

registerGovernanceRoutes(uiRouter);

uiRouter.post("/orgs/:orgId/repositories", async (c) => {
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const denied = await requireOrgAccess(c, orgId, "admin");
  if (denied) return denied;
  const parsedBody = await validateJsonBody(
    c,
    CreateRepositoryBodySchema,
    "invalid repository request",
  );
  if (!parsedBody.ok) return parsedBody.response;
  const resolvedRequest = resolveCreateRepositoryRequest(parsedBody.data);
  if (!resolvedRequest.ok) return c.json({ error: resolvedRequest.error }, 400);
  const request = resolvedRequest.request;
  const [org] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return c.json({ error: "org not found" }, 404);

  try {
    const repo = await createRepository({
      orgId,
      orgSlug: org.slug,
      name: request.name,
      format: request.format,
      kind: request.kind,
      visibility: request.visibility,
      description: request.description,
    });
    audit({
      orgId,
      action: "repository.create",
      result: "success",
      resourceType: "repository",
      resourceId: repo.id,
      principal: c.get("principal"),
      detail: { name: repo.name, format: repo.format, kind: repo.kind },
    });
    return c.json({ repository: repositoryDto(repo) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: `repository '${request.name}' already exists` }, 409);
    }
    throw err;
  }
});

registerTokenRoutes(uiRouter);
