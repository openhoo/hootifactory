import {
  authorize,
  createApiToken,
  ROLE_RANK,
  resolveUserRole,
  revokeToken,
} from "@hootifactory/auth";
import {
  addUpstream,
  addVirtualMember,
  applyRetention,
  createRepository,
  isUniqueViolation,
} from "@hootifactory/core";
import {
  and,
  apiTokens,
  artifacts,
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
  const [pkg] = await db
    .select()
    .from(packages)
    .where(eq(packages.id, c.req.param("packageId")))
    .limit(1);
  if (!pkg) return c.json({ error: "package not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", { type: "org", orgId: pkg.orgId });
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
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId: repo.orgId });
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
  const decision = await authorize(c.get("principal"), "read", { type: "org", orgId: repo.orgId });
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
  const [art] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, c.req.param("artifactId")))
    .limit(1);
  if (!art) return c.json({ error: "artifact not found" }, 404);
  const decision = await authorize(c.get("principal"), "read", { type: "org", orgId: art.orgId });
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
    await db.insert(quotas).values({ orgId, maxStorageBytes: body?.maxStorageBytes ?? null });
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

  // Prevent privilege escalation: a token's role cannot exceed its creator's.
  if (body.role) {
    const creatorRole = await resolveUserRole(p.userId, orgId);
    if (!creatorRole || ROLE_RANK[body.role] > ROLE_RANK[creatorRole]) {
      return c.json({ error: "cannot grant a role above your own" }, 403);
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
  return c.json(
    { token: { id: token.id, name: token.name, prefix: token.tokenPrefix }, secret },
    201,
  );
});
