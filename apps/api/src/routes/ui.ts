import { createOrganizationWithOwner, listAccessibleOrgs } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import { isUniqueViolation } from "@hootifactory/core";
import { registryPlugins } from "@hootifactory/registry";
import {
  createRepositoryForPrincipal,
  listRepositoriesForOrg,
} from "@hootifactory/registry-application/repositories";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { AUDIT_RESULT, audit } from "./http";
import { registerContentRoutes } from "./ui-content";
import { repositoryDto } from "./ui-dto";
import { registerGovernanceRoutes } from "./ui-governance";
import { requireOrgAccess, requireUserPrincipal } from "./ui-repository-access";
import { registerRepositoryConfigRoutes } from "./ui-repository-config";
import { CreateOrgBodySchema, CreateRepositoryBodySchema } from "./ui-schemas";
import { registerTokenRoutes } from "./ui-tokens";

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

uiRouter.get("/registry-modules", (c) =>
  c.json({
    modules: registryPlugins.all().map((module) => ({
      id: module.id,
      displayName: module.displayName,
      mountSegment: module.mountSegment,
      capabilities: module.capabilities,
    })),
  }),
);

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
    const org = await createOrganizationWithOwner({
      slug: body.slug,
      displayName: body.displayName,
      description: body.description,
      ownerUserId: p.userId,
    });
    audit({
      orgId: org.id,
      action: "org.create",
      result: AUDIT_RESULT.success,
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
  const rows = await listRepositoriesForOrg(orgId);
  return c.json({ repositories: rows.map(repositoryDto) });
});

registerContentRoutes(uiRouter);
registerRepositoryConfigRoutes(uiRouter);

registerGovernanceRoutes(uiRouter);

uiRouter.post("/orgs/:orgId/repositories", async (c) => {
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const parsedBody = await validateJsonBody(
    c,
    CreateRepositoryBodySchema,
    "invalid repository request",
  );
  if (!parsedBody.ok) return parsedBody.response;
  const created = await createRepositoryForPrincipal({
    principal: c.get("principal"),
    orgId,
    body: parsedBody.data,
  });
  if (!created.ok) return c.json({ error: created.error }, created.status);
  const { repo } = created;
  audit({
    orgId,
    action: "repository.create",
    result: AUDIT_RESULT.success,
    resourceType: "repository",
    resourceId: repo.id,
    principal: c.get("principal"),
    detail: { name: repo.name, moduleId: repo.moduleId, kind: repo.kind },
  });
  return c.json({ repository: repositoryDto(repo) }, 201);
});

registerTokenRoutes(uiRouter);
