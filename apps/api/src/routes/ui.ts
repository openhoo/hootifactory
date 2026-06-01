import {
  authorize,
  createApiToken,
  patternMatches,
  ROLE_RANK,
  resolveUserRole,
  revokeToken,
  roleAllows,
  writeAudit,
} from "@hootifactory/auth";
import {
  addUpstream,
  addVirtualMember,
  applyRetention,
  assertPublicHttpUrl,
  createRepository,
  formatRegistry,
  isUniqueViolation,
  isValidRepositoryName,
} from "@hootifactory/core";
import {
  and,
  apiTokens,
  artifacts,
  blobRefs,
  blobs,
  count,
  db,
  desc,
  eq,
  findings,
  isNull,
  memberships,
  organizations,
  packages,
  packageVersions,
  quotas,
  repositories,
  scanPolicies,
  sql,
  users,
} from "@hootifactory/db";
import type { PackageFormat, RepoKind, Visibility } from "@hootifactory/types";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../types";

export const uiRouter = new Hono<AppEnv>();

function isRepoKind(value: unknown): value is RepoKind {
  return value === "hosted" || value === "proxy" || value === "virtual";
}

function isVisibility(value: unknown): value is Visibility {
  return value === "private" || value === "public";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function scopeMayTargetRepo(pattern: string, repo: { name: string; mountPath: string }): boolean {
  if (patternMatches(pattern, repo.name)) return true;
  const ociPrefix = repo.mountPath.startsWith("v2/") ? repo.mountPath.slice(3) : null;
  if (!ociPrefix) return false;
  if (patternMatches(pattern, ociPrefix) || pattern.startsWith(`${ociPrefix}/`)) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return prefix.startsWith(`${ociPrefix}/`) || ociPrefix.startsWith(prefix);
  }
  return false;
}

type RepositoryRow = typeof repositories.$inferSelect;

function repositoryDto(repo: RepositoryRow) {
  return {
    id: repo.id,
    orgId: repo.orgId,
    name: repo.name,
    format: repo.format,
    kind: repo.kind,
    visibility: repo.visibility,
    mountPath: repo.mountPath,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

type ApiTokenRow = typeof apiTokens.$inferSelect;

function tokenDto(token: ApiTokenRow, ownerUsername?: string | null) {
  return {
    id: token.id,
    ownerUserId: token.ownerUserId,
    ownerUsername: ownerUsername ?? null,
    name: token.name,
    prefix: token.tokenPrefix,
    type: token.type,
    scopes: token.scopes,
    role: token.role,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
  };
}

uiRouter.get("/me", (c) => {
  const p = c.get("principal");
  if (p.kind === "anonymous") return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, principal: p });
});

uiRouter.get("/orgs", async (c) => {
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ orgs: [] });
  const orgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, p.userId));
  return c.json({ orgs });
});

uiRouter.post("/orgs", async (c) => {
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ error: "login required" }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    slug?: string;
    displayName?: string;
    description?: string;
  } | null;
  if (!body?.slug || !body?.displayName) {
    return c.json({ error: "slug and displayName required" }, 400);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.slug)) {
    return c.json({ error: "slug must be lowercase alphanumeric/dashes (2-63 chars)" }, 400);
  }
  try {
    const [org] = await db
      .insert(organizations)
      .values({ slug: body.slug, displayName: body.displayName, description: body.description })
      .returning();
    if (!org) return c.json({ error: "failed to create org" }, 500);
    await db.insert(memberships).values({ orgId: org.id, userId: p.userId, role: "owner" });
    return c.json({ org }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: `org slug '${body.slug}' already taken` }, 409);
    }
    throw err;
  }
});

uiRouter.get("/orgs/:orgId/repositories", async (c) => {
  const orgId = c.req.param("orgId");
  const decision = await authorize(c.get("principal"), "read", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const rows = await db.select().from(repositories).where(eq(repositories.orgId, orgId));
  return c.json({ repositories: rows.map(repositoryDto) });
});

// ── content browsing ─────────────────────────────────────────────────────
uiRouter.get("/repositories/:repoId", async (c) => {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, c.req.param("repoId")))
    .limit(1);
  if (!repo) return c.json({ error: "repository not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const countRows = await db
    .select({ value: count() })
    .from(packages)
    .where(eq(packages.repositoryId, repo.id));
  return c.json({ repository: repositoryDto(repo), packageCount: countRows[0]?.value ?? 0 });
});

uiRouter.get("/repositories/:repoId/packages", async (c) => {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, c.req.param("repoId")))
    .limit(1);
  if (!repo) return c.json({ error: "repository not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const rows = await db
    .select({ id: packages.id, name: packages.name, latestVersion: packages.latestVersion })
    .from(packages)
    .where(eq(packages.repositoryId, repo.id))
    .orderBy(packages.name);
  return c.json({ packages: rows });
});

uiRouter.get("/packages/:packageId/versions", async (c) => {
  const [row] = await db
    .select({ pkg: packages, repo: repositories })
    .from(packages)
    .innerJoin(repositories, eq(packages.repositoryId, repositories.id))
    .where(eq(packages.id, c.req.param("packageId")))
    .limit(1);
  const pkg = row?.pkg;
  const repo = row?.repo;
  if (!pkg || !repo) return c.json({ error: "package not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
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
async function repoAdminGuard(c: Context<AppEnv>, repoId: string) {
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1);
  if (!repo) return { error: c.json({ error: "repository not found" }, 404) };
  const decision = await authorize(c.get("principal"), "admin", {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (!decision.allowed) {
    return {
      error: c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403),
    };
  }
  return { repo };
}

uiRouter.post("/repositories/:repoId/members", async (c) => {
  const guard = await repoAdminGuard(c, c.req.param("repoId"));
  if ("error" in guard) return guard.error;
  if (guard.repo.kind !== "virtual") {
    return c.json({ error: "members can only be added to virtual repositories" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as {
    memberRepoId?: string;
    position?: number;
  } | null;
  if (!body?.memberRepoId) return c.json({ error: "memberRepoId required" }, 400);
  if (body.position !== undefined && !isInteger(body.position)) {
    return c.json({ error: "position must be an integer" }, 400);
  }

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
  return c.json({ ok: true }, 201);
});

uiRouter.post("/repositories/:repoId/upstreams", async (c) => {
  const guard = await repoAdminGuard(c, c.req.param("repoId"));
  if ("error" in guard) return guard.error;
  if (guard.repo.kind !== "proxy") {
    return c.json({ error: "upstreams can only be added to proxy repositories" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as { url?: string; priority?: number } | null;
  if (!body?.url) return c.json({ error: "url required" }, 400);
  if (body.priority !== undefined && !isInteger(body.priority)) {
    return c.json({ error: "priority must be an integer" }, 400);
  }
  // Reject private/loopback/metadata upstreams at configuration time (SSRF guard).
  try {
    assertPublicHttpUrl(body.url);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid upstream url" }, 400);
  }
  await addUpstream(guard.repo.id, body.url, body.priority ?? 0);
  return c.json({ ok: true }, 201);
});

// ── scanning ─────────────────────────────────────────────────────────────
uiRouter.post("/orgs/:orgId/scan-policies", async (c) => {
  const orgId = c.req.param("orgId");
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    repositoryPattern?: string;
    mode?: "audit" | "enforce";
    blockOnSeverity?: "critical" | "high" | "medium" | "low" | "negligible" | "unknown";
  } | null;
  if (!body?.mode) return c.json({ error: "mode required" }, 400);
  const [row] = await db
    .insert(scanPolicies)
    .values({
      orgId,
      repositoryPattern: body.repositoryPattern ?? "*",
      mode: body.mode,
      blockOnSeverity: body.blockOnSeverity ?? null,
    })
    .returning();
  return c.json({ policy: row }, 201);
});

uiRouter.get("/repositories/:repoId/artifacts", async (c) => {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, c.req.param("repoId")))
    .limit(1);
  if (!repo) return c.json({ error: "repository not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const rows = await db
    .select({
      id: artifacts.id,
      digest: artifacts.digest,
      name: artifacts.name,
      version: artifacts.version,
      state: artifacts.state,
      policyDecision: artifacts.policyDecision,
    })
    .from(artifacts)
    .where(eq(artifacts.repositoryId, repo.id))
    .orderBy(desc(artifacts.createdAt));
  return c.json({ artifacts: rows });
});

uiRouter.get("/artifacts/:artifactId/findings", async (c) => {
  const [row] = await db
    .select({ art: artifacts, repo: repositories })
    .from(artifacts)
    .innerJoin(repositories, eq(artifacts.repositoryId, repositories.id))
    .where(eq(artifacts.id, c.req.param("artifactId")))
    .limit(1);
  const art = row?.art;
  const repo = row?.repo;
  if (!art || !repo) return c.json({ error: "artifact not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const rows = await db
    .select({
      vulnId: findings.vulnId,
      type: findings.type,
      severity: findings.severity,
      packageName: findings.packageName,
      packageVersion: findings.packageVersion,
      fixedVersion: findings.fixedVersion,
      title: findings.title,
    })
    .from(findings)
    .where(eq(findings.artifactId, art.id));
  return c.json({ findings: rows });
});

// ── governance: quotas + retention ───────────────────────────────────────
uiRouter.get("/orgs/:orgId/quota", async (c) => {
  const orgId = c.req.param("orgId");
  const decision = await authorize(c.get("principal"), "read", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const [q] = await db
    .select()
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  return c.json({
    maxStorageBytes: q?.maxStorageBytes ?? null,
    usedStorageBytes: q?.usedStorageBytes ?? 0,
  });
});

uiRouter.post("/orgs/:orgId/quota", async (c) => {
  const orgId = c.req.param("orgId");
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const body = (await c.req.json().catch(() => null)) as { maxStorageBytes?: number } | null;
  const [existing] = await db
    .select({ id: quotas.id })
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  if (existing) {
    await db
      .update(quotas)
      .set({ maxStorageBytes: body?.maxStorageBytes ?? null })
      .where(eq(quotas.id, existing.id));
  } else {
    // Backfill usedStorageBytes from the physical bytes the org's repos already
    // reference, so a quota created after data exists isn't under-counted.
    const [agg] = await db
      .select({ used: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
      .from(blobs)
      .where(
        sql`${blobs.digest} in (select distinct ${blobRefs.digest} from ${blobRefs} join ${repositories} on ${blobRefs.repositoryId} = ${repositories.id} where ${repositories.orgId} = ${orgId})`,
      );
    await db.insert(quotas).values({
      orgId,
      maxStorageBytes: body?.maxStorageBytes ?? null,
      usedStorageBytes: Number(agg?.used ?? 0),
    });
  }
  return c.json({ ok: true });
});

uiRouter.post("/repositories/:repoId/retention/apply", async (c) => {
  const guard = await repoAdminGuard(c, c.req.param("repoId"));
  if ("error" in guard) return guard.error;
  const body = (await c.req.json().catch(() => null)) as { keepLastN?: number } | null;
  const keepLastN = body?.keepLastN ?? 10;
  if (!Number.isInteger(keepLastN) || keepLastN < 1) {
    return c.json({ error: "keepLastN must be a positive integer" }, 400);
  }
  const pruned = await applyRetention(guard.repo.id, keepLastN);
  return c.json({ pruned });
});

uiRouter.post("/orgs/:orgId/repositories", async (c) => {
  const orgId = c.req.param("orgId");
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    format?: PackageFormat;
    kind?: unknown;
    visibility?: unknown;
    description?: string;
  } | null;
  if (!body?.name || !body?.format) {
    return c.json({ error: "name and format required" }, 400);
  }
  if (!isValidRepositoryName(body.name)) {
    return c.json(
      {
        error: "repository name must be path-safe: letters, numbers, dots, underscores, or dashes",
      },
      400,
    );
  }
  if (!formatRegistry.has(body.format)) {
    return c.json({ error: `unsupported repository format '${body.format}'` }, 400);
  }
  const kind = body.kind ?? "hosted";
  if (!isRepoKind(kind)) {
    return c.json({ error: `unsupported repository kind '${String(body.kind)}'` }, 400);
  }
  const visibility = body.visibility ?? "private";
  if (!isVisibility(visibility)) {
    return c.json({ error: `unsupported repository visibility '${String(body.visibility)}'` }, 400);
  }
  const adapter = formatRegistry.lookup(body.format);
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
      format: body.format,
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

uiRouter.get("/orgs/:orgId/tokens", async (c) => {
  const orgId = c.req.param("orgId");
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ error: "login required" }, 401);
  const adminDecision = await authorize(p, "admin", { type: "org", orgId });
  const readDecision = adminDecision.allowed
    ? adminDecision
    : await authorize(p, "read", { type: "org", orgId });
  if (!readDecision.allowed) return c.json({ error: readDecision.reason }, 403);
  const where = adminDecision.allowed
    ? eq(apiTokens.orgId, orgId)
    : and(eq(apiTokens.orgId, orgId), eq(apiTokens.ownerUserId, p.userId));
  const rows = await db
    .select({
      id: apiTokens.id,
      ownerUserId: apiTokens.ownerUserId,
      ownerUsername: users.username,
      name: apiTokens.name,
      prefix: apiTokens.tokenPrefix,
      type: apiTokens.type,
      scopes: apiTokens.scopes,
      role: apiTokens.role,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(where)
    .orderBy(desc(apiTokens.createdAt));
  return c.json({ tokens: rows });
});

uiRouter.delete("/orgs/:orgId/tokens/:tokenId", async (c) => {
  const orgId = c.req.param("orgId");
  const tokenId = c.req.param("tokenId");
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ error: "login required" }, 401);
  const [tok] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1);
  if (!tok || tok.orgId !== orgId) return c.json({ error: "token not found" }, 404);
  // owner of the token, or org admin
  const isOwner = tok.ownerUserId === p.userId;
  if (!isOwner) {
    const decision = await authorize(p, "admin", { type: "org", orgId });
    if (!decision.allowed) return c.json({ error: "forbidden" }, 403);
  }
  await revokeToken(tokenId);
  void writeAudit({
    orgId,
    action: "token.revoke",
    result: "success",
    resourceType: "token",
    resourceId: tokenId,
    principal: p,
  }).catch(() => {});
  return c.json({ ok: true });
});

uiRouter.post("/orgs/:orgId/tokens", async (c) => {
  const orgId = c.req.param("orgId");
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ error: "login required" }, 401);
  const decision = await authorize(p, "read", { type: "org", orgId });
  if (!decision.allowed) return c.json({ error: decision.reason }, 403);

  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    type?: "personal" | "robot";
    scopes?: { repository: string; actions: ("read" | "write" | "delete" | "admin")[] }[];
    role?: "viewer" | "developer" | "admin" | "owner";
    expiresAt?: string | null;
  } | null;
  if (!body?.name) return c.json({ error: "name required" }, 400);
  const hasScopes = (body.scopes?.length ?? 0) > 0;
  const requestedRole = body.role ?? (hasScopes ? undefined : "developer");
  const expiresAt =
    body.expiresAt === null
      ? null
      : body.expiresAt
        ? new Date(body.expiresAt)
        : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: "expiresAt must be an ISO timestamp or null" }, 400);
  }

  // Prevent privilege escalation: neither the token's role NOR its scope actions
  // may exceed the creator's own org role. (Scopes act as a hard ceiling in can(),
  // so an unchecked scope would let a viewer mint a write/delete/admin token.)
  const creatorRole = await resolveUserRole(p.userId, orgId);
  if (requestedRole && (!creatorRole || ROLE_RANK[requestedRole] > ROLE_RANK[creatorRole])) {
    return c.json({ error: "cannot grant a role above your own" }, 403);
  }
  const orgRepos =
    requestedRole || body.scopes?.length
      ? await db
          .select({
            id: repositories.id,
            name: repositories.name,
            mountPath: repositories.mountPath,
          })
          .from(repositories)
          .where(eq(repositories.orgId, orgId))
      : [];
  if (requestedRole) {
    for (const repo of orgRepos) {
      const repoRole = await resolveUserRole(p.userId, orgId, repo.id);
      if (!repoRole || ROLE_RANK[requestedRole] > ROLE_RANK[repoRole]) {
        return c.json(
          { error: `cannot grant role '${requestedRole}' on repository '${repo.name}'` },
          403,
        );
      }
    }
  }
  for (const scope of body.scopes ?? []) {
    for (const action of scope.actions) {
      if (!creatorRole || !roleAllows(creatorRole, action)) {
        return c.json({ error: `cannot grant scope action '${action}' beyond your role` }, 403);
      }
    }
    for (const repo of orgRepos) {
      if (!scopeMayTargetRepo(scope.repository, repo)) continue;
      const repoRole = await resolveUserRole(p.userId, orgId, repo.id);
      for (const action of scope.actions) {
        if (!repoRole || !roleAllows(repoRole, action)) {
          return c.json(
            {
              error: `cannot grant scope action '${action}' on repository '${repo.name}'`,
            },
            403,
          );
        }
      }
    }
  }

  const { token, secret } = await createApiToken({
    orgId,
    ownerUserId: p.userId,
    name: body.name,
    type: body.type,
    scopes: body.scopes,
    role: requestedRole,
    expiresAt,
  });
  void writeAudit({
    orgId,
    action: "token.create",
    result: "success",
    resourceType: "token",
    resourceId: token.id,
    principal: p,
    detail: { name: token.name, type: token.type },
  }).catch(() => {});
  return c.json({ token: tokenDto(token, p.username), secret }, 201);
});
