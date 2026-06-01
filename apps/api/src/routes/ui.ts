import {
  type Action,
  authorize,
  createApiToken,
  patternMatches,
  ROLE_RANK,
  resolveUserRole,
  revokeToken,
  roleAllows,
  writeAudit,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";
import {
  addUpstream,
  addVirtualMember,
  applyRetention,
  assertPublicHttpUrl,
  createRepository,
  formatRegistry,
  isUniqueViolation,
  isValidRepositoryName,
  z,
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
  externalRoleGrants,
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
import { isValidRepositoryPattern, SEVERITY_ORDER, type Severity } from "@hootifactory/scan-core";
import type { PackageFormat } from "@hootifactory/types";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { uuidParams, validateInput, validateJsonBody } from "../validation";

export const uiRouter = new Hono<AppEnv>();

type ParsedTokenScope = { repository: string; actions: Action[] };

const RoleNameSchema = z.enum(["viewer", "developer", "admin", "owner"]);
const ActionSchema = z.enum(["read", "write", "delete", "admin"]);
const RepoKindSchema = z.enum(["hosted", "proxy", "virtual"]);
const VisibilitySchema = z.enum(["private", "public"]);
const PolicyModeSchema = z.enum(["audit", "enforce"]);
const TokenTypeSchema = z.enum(["personal", "robot"]);
const SeveritySchema = z.enum(Object.keys(SEVERITY_ORDER) as [Severity, ...Severity[]]);
const RepositoryFormatSchema = z.string().trim().min(1).max(64);
const OptionalDescriptionSchema = z.string().trim().max(2048).optional();

const CreateOrgBodySchema = z.strictObject({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "slug must be lowercase alphanumeric/dashes (2-63 chars)"),
  displayName: z.string().trim().min(1).max(256),
  description: OptionalDescriptionSchema,
});

const AddMemberBodySchema = z.strictObject({
  memberRepoId: z.uuid(),
  position: z.number().int().min(0).max(1_000_000).optional(),
});

const AddUpstreamBodySchema = z.strictObject({
  url: z.url().max(2048),
  priority: z.number().int().min(0).max(1_000_000).optional(),
});

const ScanPolicyBodySchema = z.strictObject({
  repositoryPattern: z.string().max(512).optional(),
  mode: PolicyModeSchema,
  blockOnSeverity: SeveritySchema.nullish(),
});

const QuotaBodySchema = z.strictObject({
  maxStorageBytes: z.number().int().safe().min(0).nullable().optional(),
  maxArtifacts: z.number().int().safe().min(0).nullable().optional(),
});

const RetentionBodySchema = z.strictObject({
  keepLastN: z.number().int().min(1).max(10_000).default(10),
});

const CreateRepositoryBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  format: RepositoryFormatSchema,
  kind: z.unknown().optional(),
  visibility: z.unknown().optional(),
  description: OptionalDescriptionSchema,
});

const TokenScopeSchema = z
  .strictObject({
    repository: z.string().min(1).max(512),
    actions: z.array(ActionSchema).min(1).max(4),
  })
  .transform((scope): ParsedTokenScope => {
    const actions: Action[] = [];
    for (const action of scope.actions) {
      if (!actions.includes(action)) actions.push(action);
    }
    return { repository: scope.repository, actions };
  });

const CreateTokenBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  type: TokenTypeSchema.default("personal"),
  scopes: z.array(TokenScopeSchema).max(100).default([]),
  role: RoleNameSchema.optional(),
  expiresAt: z.union([z.iso.datetime().transform((value) => new Date(value)), z.null()]).optional(),
});

function validateParams<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
  message = "invalid path parameters",
) {
  return validateInput(c, schema, c.req.param(), message);
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
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1);
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
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const { repoId } = parsedParams.data;
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1);
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
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const guard = await repoAdminGuard(c, parsedParams.data.repoId);
  if ("error" in guard) return guard.error;
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
  const guard = await repoAdminGuard(c, parsedParams.data.repoId);
  if ("error" in guard) return guard.error;
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

// ── scanning ─────────────────────────────────────────────────────────────
uiRouter.post("/orgs/:orgId/scan-policies", async (c) => {
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const parsedBody = await validateJsonBody(c, ScanPolicyBodySchema, "invalid scan policy request");
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const repositoryPattern = body.repositoryPattern ?? "*";
  if (!isValidRepositoryPattern(repositoryPattern)) {
    return c.json(
      {
        error:
          "repository pattern must use repository-name characters plus '*' wildcards, or '*' for all repositories",
      },
      400,
    );
  }
  const blockOnSeverity = body.blockOnSeverity ?? null;
  const [row] = await db
    .insert(scanPolicies)
    .values({
      orgId,
      repositoryPattern,
      mode: body.mode,
      blockOnSeverity,
    })
    .returning();
  void writeAudit({
    orgId,
    action: "scan_policy.create",
    result: "success",
    resourceType: "scan_policy",
    resourceId: row?.id,
    principal: c.get("principal"),
    detail: {
      repositoryPattern,
      mode: body.mode,
      blockOnSeverity,
    },
  }).catch(() => {});
  return c.json({ policy: row }, 201);
});

uiRouter.get("/repositories/:repoId/artifacts", async (c) => {
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const { repoId } = parsedParams.data;
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1);
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
  const parsedParams = validateParams(c, uuidParams.artifactId);
  if (!parsedParams.ok) return parsedParams.response;
  const { artifactId } = parsedParams.data;
  const [row] = await db
    .select({ art: artifacts, repo: repositories })
    .from(artifacts)
    .innerJoin(repositories, eq(artifacts.repositoryId, repositories.id))
    .where(eq(artifacts.id, artifactId))
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
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
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
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const decision = await authorize(c.get("principal"), "admin", { type: "org", orgId });
  if (!decision.allowed) {
    return c.json({ error: decision.reason }, decision.code === "unauthenticated" ? 401 : 403);
  }
  const parsedBody = await validateJsonBody(c, QuotaBodySchema, "invalid quota request");
  if (!parsedBody.ok) return parsedBody.response;
  const maxStorageBytes = parsedBody.data.maxStorageBytes ?? null;
  const maxArtifacts = parsedBody.data.maxArtifacts ?? null;
  // Backfill usage from the physical bytes/artifacts the org's repos already
  // reference, so quota updates after data exists aren't under-counted.
  const [agg] = await db
    .select({ used: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
    .from(blobs)
    .where(
      sql`${blobs.digest} in (select distinct ${blobRefs.digest} from ${blobRefs} join ${repositories} on ${blobRefs.repositoryId} = ${repositories.id} where ${repositories.orgId} = ${orgId})`,
    );
  const [artifactAgg] = await db
    .select({ used: count() })
    .from(packageVersions)
    .where(eq(packageVersions.orgId, orgId));
  const usedStorageBytes = Number(agg?.used ?? 0);
  const usedArtifacts = artifactAgg?.used ?? 0;
  const [existing] = await db
    .select({ id: quotas.id })
    .from(quotas)
    .where(and(eq(quotas.orgId, orgId), isNull(quotas.repositoryId)))
    .limit(1);
  if (existing) {
    await db
      .update(quotas)
      .set({ maxStorageBytes, maxArtifacts, usedStorageBytes, usedArtifacts })
      .where(eq(quotas.id, existing.id));
  } else {
    await db.insert(quotas).values({
      orgId,
      maxStorageBytes,
      maxArtifacts,
      usedStorageBytes,
      usedArtifacts,
    });
  }
  void writeAudit({
    orgId,
    action: "quota.set",
    result: "success",
    resourceType: "quota",
    principal: c.get("principal"),
    detail: { maxStorageBytes },
  }).catch(() => {});
  return c.json({ ok: true });
});

uiRouter.post("/repositories/:repoId/retention/apply", async (c) => {
  const parsedParams = validateParams(c, uuidParams.repoId);
  if (!parsedParams.ok) return parsedParams.response;
  const guard = await repoAdminGuard(c, parsedParams.data.repoId);
  if ("error" in guard) return guard.error;
  const parsedBody = await validateJsonBody(c, RetentionBodySchema, "invalid retention request");
  if (!parsedBody.ok) return parsedBody.response;
  const { keepLastN } = parsedBody.data;
  const pruned = await applyRetention(guard.repo.id, keepLastN);
  void writeAudit({
    orgId: guard.repo.orgId,
    action: "retention.apply",
    result: "success",
    resourceType: "repository",
    resourceId: guard.repo.id,
    principal: c.get("principal"),
    detail: { keepLastN, pruned },
  }).catch(() => {});
  return c.json({ pruned });
});

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

uiRouter.get("/orgs/:orgId/tokens", async (c) => {
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
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
  const parsedParams = validateParams(c, uuidParams.orgToken);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId, tokenId } = parsedParams.data;
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
  const parsedParams = validateParams(c, uuidParams.orgId);
  if (!parsedParams.ok) return parsedParams.response;
  const { orgId } = parsedParams.data;
  const p = c.get("principal");
  if (p.kind !== "user") return c.json({ error: "login required" }, 401);
  const decision = await authorize(p, "read", { type: "org", orgId });
  if (!decision.allowed) return c.json({ error: decision.reason }, 403);

  const parsedBody = await validateJsonBody(c, CreateTokenBodySchema, "invalid token request");
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const tokenName = body.name;
  const tokenType = body.type;
  const parsedScopes = { scopes: body.scopes };
  const requestedRole = body.role ?? (parsedScopes.scopes.length > 0 ? undefined : "developer");
  const expiresAt =
    body.expiresAt === undefined ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) : body.expiresAt;

  // Prevent privilege escalation: neither the token's role NOR its scope actions
  // may exceed the creator's own org role. (Scopes act as a hard ceiling in can(),
  // so an unchecked scope would let a viewer mint a write/delete/admin token.)
  const creatorRole = await resolveUserRole(p.userId, orgId);
  if (requestedRole && (!creatorRole || ROLE_RANK[requestedRole] > ROLE_RANK[creatorRole])) {
    return c.json({ error: "cannot grant a role above your own" }, 403);
  }
  const orgRepos =
    requestedRole || parsedScopes.scopes.length
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
  for (const scope of parsedScopes.scopes) {
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
    name: tokenName,
    type: tokenType,
    scopes: parsedScopes.scopes,
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
