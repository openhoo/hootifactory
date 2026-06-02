import { authorize, ROLE_RANK, writeAudit } from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  addUpstream,
  addVirtualMember,
  assertPublicHttpUrl,
  createRepository,
  formatRegistry,
  isUniqueViolation,
  isValidRepositoryName,
  isValidRepositoryNameForFormat,
} from "@hootifactory/core";
import {
  and,
  count,
  db,
  desc,
  eq,
  externalRoleGrants,
  isNull,
  memberships,
  organizations,
  packages,
  packageVersions,
  repositories,
} from "@hootifactory/db";
import type { PackageFormat } from "@hootifactory/types";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateJsonBody, validateParams } from "../validation";
import { repositoryDto } from "./ui-dto";
import { registerGovernanceRoutes } from "./ui-governance";
import { authorizeRepository, requireRepositoryAccess } from "./ui-repository-access";
import {
  AddMemberBodySchema,
  AddUpstreamBodySchema,
  CreateOrgBodySchema,
  CreateRepositoryBodySchema,
  RepoKindSchema,
  VisibilitySchema,
} from "./ui-schemas";
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
  const membershipOrgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, p.userId));
  const externalOrgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
      role: externalRoleGrants.role,
    })
    .from(externalRoleGrants)
    .innerJoin(organizations, eq(externalRoleGrants.orgId, organizations.id))
    .where(eq(externalRoleGrants.userId, p.userId));
  const byId = new Map<string, (typeof membershipOrgs)[number]>();
  for (const org of [...membershipOrgs, ...externalOrgs]) {
    const existing = byId.get(org.id);
    if (!existing || ROLE_RANK[org.role] > ROLE_RANK[existing.role]) byId.set(org.id, org);
  }
  const orgs = [...byId.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  return c.json({ orgs });
});

uiRouter.post("/orgs", async (c) => {
  if (!env.AUTH_ALLOW_ORG_CREATION) {
    return c.json({ error: "org creation is disabled" }, 403);
  }
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ error: "login required" }, 401);
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
    void writeAudit({
      orgId: org.id,
      action: "org.create",
      result: "success",
      resourceType: "org",
      resourceId: org.id,
      principal: p,
      detail: { slug: org.slug },
    }).catch(() => {});
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
  const decision = await authorize(c.get("principal"), "read", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const rows = await db.select().from(repositories).where(eq(repositories.orgId, orgId));
  return c.json({ repositories: rows.map(repositoryDto) });
});

// ── content browsing ─────────────────────────────────────────────────────
uiRouter.get("/repositories/:repoId", async (c) => {
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const { repoId } = parsedParams.data;
  const access = await requireRepositoryAccess(c, repoId, "read");
  if (!access.ok) return access.response;
  const { repo } = access;
  const countRows = await db
    .select({ value: count() })
    .from(packages)
    .where(eq(packages.repositoryId, repo.id));
  return c.json({ repository: repositoryDto(repo), packageCount: countRows[0]?.value ?? 0 });
});

uiRouter.get("/repositories/:repoId/packages", async (c) => {
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const { repoId } = parsedParams.data;
  const access = await requireRepositoryAccess(c, repoId, "read");
  if (!access.ok) return access.response;
  const { repo } = access;
  const rows = await db
    .select({ id: packages.id, name: packages.name, latestVersion: packages.latestVersion })
    .from(packages)
    .where(eq(packages.repositoryId, repo.id))
    .orderBy(packages.name);
  return c.json({ packages: rows });
});

uiRouter.get("/packages/:packageId/versions", async (c) => {
  const parsedParams = validateParams(c, uuidParams.packageId);
  if (!parsedParams.ok) return parsedParams.response;
  const { packageId } = parsedParams.data;
  const [row] = await db
    .select({ pkg: packages, repo: repositories })
    .from(packages)
    .innerJoin(repositories, eq(packages.repositoryId, repositories.id))
    .where(eq(packages.id, packageId))
    .limit(1);
  const pkg = row?.pkg;
  const repo = row?.repo;
  if (!pkg || !repo) return c.json({ error: "package not found" }, 404);
  const denied = await authorizeRepository(c, "read", repo);
  if (denied) return denied;
  const rows = await db
    .select({
      version: packageVersions.version,
      sizeBytes: packageVersions.sizeBytes,
      createdAt: packageVersions.createdAt,
    })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)))
    .orderBy(desc(packageVersions.createdAt));
  return c.json({ package: { id: pkg.id, name: pkg.name }, versions: rows });
});

// ── proxy/virtual configuration ──────────────────────────────────────────
uiRouter.post("/repositories/:repoId/members", async (c) => {
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const guard = await requireRepositoryAccess(c, parsedParams.data.repoId, "admin");
  if (!guard.ok) return guard.response;
  if (guard.repo.kind !== "virtual") {
    return c.json({ error: "members can only be added to virtual repositories" }, 400);
  }
  const parsedBody = await validateJsonBody(c, AddMemberBodySchema, "invalid member request");
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;

  const [member] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, body.memberRepoId))
    .limit(1);
  if (!member) return c.json({ error: "member repository not found" }, 404);
  if (member.id === guard.repo.id) {
    return c.json({ error: "virtual repositories cannot include themselves" }, 400);
  }
  if (member.format !== guard.repo.format) {
    return c.json({ error: "virtual repository members must use the same format" }, 400);
  }
  if (member.kind !== "hosted") {
    return c.json({ error: "virtual repository members must be hosted repositories" }, 400);
  }
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
  void writeAudit({
    orgId: guard.repo.orgId,
    action: "repository.member.add",
    result: "success",
    resourceType: "repository",
    resourceId: guard.repo.id,
    principal: c.get("principal"),
    detail: { memberRepoId: member.id, memberName: member.name, position: body.position ?? 0 },
  }).catch(() => {});
  return c.json({ ok: true }, 201);
});

uiRouter.post("/repositories/:repoId/upstreams", async (c) => {
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const guard = await requireRepositoryAccess(c, parsedParams.data.repoId, "admin");
  if (!guard.ok) return guard.response;
  if (guard.repo.kind !== "proxy") {
    return c.json({ error: "upstreams can only be added to proxy repositories" }, 400);
  }
  const parsedBody = await validateJsonBody(c, AddUpstreamBodySchema, "invalid upstream request");
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  // Reject private/loopback/metadata upstreams at configuration time (SSRF guard).
  try {
    assertPublicHttpUrl(body.url);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid upstream url" }, 400);
  }
  await addUpstream(guard.repo.id, body.url, body.priority ?? 0);
  void writeAudit({
    orgId: guard.repo.orgId,
    action: "repository.upstream.add",
    result: "success",
    resourceType: "repository",
    resourceId: guard.repo.id,
    principal: c.get("principal"),
    detail: { url: body.url, priority: body.priority ?? 0 },
  }).catch(() => {});
  return c.json({ ok: true }, 201);
});

registerGovernanceRoutes(uiRouter);

uiRouter.post("/orgs/:orgId/repositories", async (c) => {
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const parsedBody = await validateJsonBody(
    c,
    CreateRepositoryBodySchema,
    "invalid repository request",
  );
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (!isValidRepositoryName(body.name)) {
    return c.json(
      {
        error: "repository name must be path-safe: letters, numbers, dots, underscores, or dashes",
      },
      400,
    );
  }
  const format = body.format as PackageFormat;
  if (!formatRegistry.has(format)) {
    return c.json({ error: `unsupported repository format '${body.format}'` }, 400);
  }
  if (!isValidRepositoryNameForFormat(format, body.name)) {
    return c.json(
      {
        error:
          "repository name is invalid for this format; OCI-family repositories must be lowercase",
      },
      400,
    );
  }
  const parsedKind = RepoKindSchema.safeParse(body.kind ?? "hosted");
  if (!parsedKind.success) {
    return c.json({ error: `unsupported repository kind '${String(body.kind)}'` }, 400);
  }
  const kind = parsedKind.data;
  const parsedVisibility = VisibilitySchema.safeParse(body.visibility ?? "private");
  if (!parsedVisibility.success) {
    return c.json({ error: `unsupported repository visibility '${String(body.visibility)}'` }, 400);
  }
  const visibility = parsedVisibility.data;
  const adapter = formatRegistry.lookup(format);
  if (kind === "proxy" && !adapter?.proxyIngest) {
    return c.json(
      { error: `proxy repositories are not supported for format '${body.format}'` },
      400,
    );
  }
  if (kind === "virtual" && !adapter?.capabilities.virtualizable) {
    return c.json(
      { error: `virtual repositories are not supported for format '${body.format}'` },
      400,
    );
  }
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
      name: body.name,
      format,
      kind,
      visibility,
      description: body.description,
    });
    void writeAudit({
      orgId,
      action: "repository.create",
      result: "success",
      resourceType: "repository",
      resourceId: repo.id,
      principal: c.get("principal"),
      detail: { name: repo.name, format: repo.format, kind: repo.kind },
    }).catch(() => {});
    return c.json({ repository: repositoryDto(repo) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: `repository '${body.name}' already exists` }, 409);
    }
    throw err;
  }
});

registerTokenRoutes(uiRouter);
