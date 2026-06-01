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
} from "@hootifactory/db";
import type { PackageFormat, Visibility } from "@hootifactory/types";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../types";

export const uiRouter = new Hono<AppEnv>();

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
  return c.json({ repositories: rows });
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
  return c.json({ repository: repo, packageCount: countRows[0]?.value ?? 0 });
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
    .where(eq(packageVersions.packageId, pkg.id))
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
  const body = (await c.req.json().catch(() => null)) as {
    memberRepoId?: string;
    position?: number;
  } | null;
  if (!body?.memberRepoId) return c.json({ error: "memberRepoId required" }, 400);
  await addVirtualMember(guard.repo.id, body.memberRepoId, body.position ?? 0);
  return c.json({ ok: true }, 201);
});

uiRouter.post("/repositories/:repoId/upstreams", async (c) => {
  const guard = await repoAdminGuard(c, c.req.param("repoId"));
  if ("error" in guard) return guard.error;
  const body = (await c.req.json().catch(() => null)) as { url?: string; priority?: number } | null;
  if (!body?.url) return c.json({ error: "url required" }, 400);
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
  const pruned = await applyRetention(guard.repo.id, body?.keepLastN ?? 10);
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
    kind?: "hosted" | "proxy" | "virtual";
    visibility?: Visibility;
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
      kind: body.kind,
      visibility: body.visibility,
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
    return c.json({ repository: repo }, 201);
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
  const decision = await authorize(p, "read", { type: "org", orgId });
  if (!decision.allowed) return c.json({ error: decision.reason }, 403);
  const rows = await db
    .select({
      id: apiTokens.id,
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
    .where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.ownerUserId, p.userId)))
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
  } | null;
  if (!body?.name) return c.json({ error: "name required" }, 400);

  // Prevent privilege escalation: neither the token's role NOR its scope actions
  // may exceed the creator's own org role. (Scopes act as a hard ceiling in can(),
  // so an unchecked scope would let a viewer mint a write/delete/admin token.)
  const creatorRole = await resolveUserRole(p.userId, orgId);
  if (body.role && (!creatorRole || ROLE_RANK[body.role] > ROLE_RANK[creatorRole])) {
    return c.json({ error: "cannot grant a role above your own" }, 403);
  }
  const orgRepos =
    body.role || body.scopes?.length
      ? await db
          .select({ id: repositories.id, name: repositories.name })
          .from(repositories)
          .where(eq(repositories.orgId, orgId))
      : [];
  if (body.role) {
    for (const repo of orgRepos) {
      const repoRole = await resolveUserRole(p.userId, orgId, repo.id);
      if (!repoRole || ROLE_RANK[body.role] > ROLE_RANK[repoRole]) {
        return c.json(
          { error: `cannot grant role '${body.role}' on repository '${repo.name}'` },
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
      if (!patternMatches(scope.repository, repo.name)) continue;
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
    role: body.role,
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
  return c.json(
    { token: { id: token.id, name: token.name, prefix: token.tokenPrefix }, secret },
    201,
  );
});
