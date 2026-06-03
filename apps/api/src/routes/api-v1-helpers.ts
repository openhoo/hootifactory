import {
  type ApiTokenRow,
  authorize,
  type Decision,
  httpStatusForDenial,
  type Principal,
} from "@hootifactory/auth";
import { z, zodIssueTree } from "@hootifactory/core";
import type { ResolvedRepo } from "@hootifactory/registry";
import {
  type ArtifactWithRepositoryRow,
  getArtifactWithRepository,
  getPackageWithRepository,
  getRepositoryById,
  listRepositoriesForOrg,
  type PackageWithRepositoryRow,
} from "@hootifactory/registry-application";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute } from "hono-openapi";
import type { AppEnv } from "../types";
import { uuidParam } from "../validation";

type ApiV1Action = "read" | "write" | "delete" | "admin";
type ValidationResult<T> = { ok: true; data: T } | { ok: false; response: Response };

export const PaginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const OrgIdParamsSchema = z.strictObject({ orgId: uuidParam });
export const RepoIdParamsSchema = z.strictObject({ repoId: uuidParam });
export const PackageIdParamsSchema = z.strictObject({ packageId: uuidParam });
export const ArtifactIdParamsSchema = z.strictObject({ artifactId: uuidParam });
export const TokenIdParamsSchema = z.strictObject({ tokenId: uuidParam });
export const OrgTokenParamsSchema = z.strictObject({ orgId: uuidParam, tokenId: uuidParam });

export function dataResponse(
  c: Context<AppEnv>,
  data: unknown,
  status: ContentfulStatusCode = 200,
): Response {
  return c.json({ data }, status);
}

export function listResponse(
  c: Context<AppEnv>,
  data: unknown[],
  pagination: { limit: number; offset: number; total: number },
): Response {
  return c.json({ data, pagination });
}

export function errorResponse(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  issues?: unknown,
): Response {
  return c.json({ error: { code, message, ...(issues ? { issues } : {}) } }, status);
}

export function validateV1<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
  input: unknown,
  message: string,
): ValidationResult<z.output<T>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    response: errorResponse(c, 400, "BAD_REQUEST", message, zodIssueTree(parsed.error)),
  };
}

export async function validateJsonV1<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
  message: string,
): Promise<ValidationResult<z.output<T>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: errorResponse(c, 400, "BAD_REQUEST", "invalid JSON body") };
  }
  return validateV1(c, schema, body, message);
}

export function validatePagination(c: Context<AppEnv>) {
  return validateV1(c, PaginationQuerySchema, c.req.query(), "invalid pagination query");
}

export function principalActor(principal: Principal) {
  return {
    userId: principal.kind === "user" ? principal.userId : null,
    tokenId: principal.kind === "token" ? principal.tokenId : null,
  };
}

export function authorizationDenied(c: Context<AppEnv>, decision: Decision): Response {
  const status = httpStatusForDenial(decision);
  return errorResponse(
    c,
    status,
    status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
    decision.reason ?? (status === 401 ? "authentication required" : "access denied"),
  );
}

export async function requireOrg(c: Context<AppEnv>, orgId: string, action: ApiV1Action) {
  const decision = await authorize(c.get("principal"), action, { type: "org", orgId });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function repositoryById(repoId: string) {
  return getRepositoryById(repoId);
}

export async function authorizeRepository(
  c: Context<AppEnv>,
  repo: ResolvedRepo,
  action: ApiV1Action,
) {
  const decision = await authorize(c.get("principal"), action, {
    type: "repository",
    orgId: repo.orgId,
    repositoryId: repo.id,
    repositoryName: repo.name,
    visibility: repo.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function requireRepository(
  c: Context<AppEnv>,
  repoId: string,
  action: ApiV1Action,
): Promise<{ ok: true; repo: ResolvedRepo } | { ok: false; response: Response }> {
  const repo = await repositoryById(repoId);
  if (!repo)
    return { ok: false, response: errorResponse(c, 404, "NOT_FOUND", "repository not found") };
  const response = await authorizeRepository(c, repo, action);
  if (response) return { ok: false, response };
  return { ok: true, repo };
}

export async function packageWithRepository(packageId: string) {
  return getPackageWithRepository(packageId);
}

export async function authorizePackage(
  c: Context<AppEnv>,
  row: PackageWithRepositoryRow,
  action: ApiV1Action,
) {
  const decision = await authorize(c.get("principal"), action, {
    type: "package",
    orgId: row.repo.orgId,
    repositoryId: row.repo.id,
    repositoryName: row.repo.name,
    packageName: row.pkg.name,
    visibility: row.repo.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function artifactWithRepository(artifactId: string) {
  return getArtifactWithRepository(artifactId);
}

export async function authorizeArtifact(
  c: Context<AppEnv>,
  row: ArtifactWithRepositoryRow,
  action: ApiV1Action,
) {
  const decision = await authorize(c.get("principal"), action, {
    type: "artifact",
    orgId: row.repo.orgId,
    repositoryId: row.repo.id,
    repositoryName: row.repo.name,
    artifactRef: row.art.digest,
    visibility: row.repo.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function authorizePolicy(
  c: Context<AppEnv>,
  input: {
    orgId: string;
    policy: "scan" | "quota" | "retention";
    action: ApiV1Action;
    repo?: ResolvedRepo;
  },
) {
  const decision = await authorize(c.get("principal"), input.action, {
    type: "policy",
    orgId: input.orgId,
    repositoryId: input.repo?.id,
    repositoryName: input.repo?.name,
    policy: input.policy,
    visibility: input.repo?.visibility,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function tokenResource(c: Context<AppEnv>, token: ApiTokenRow, action: ApiV1Action) {
  const principal = c.get("principal");
  const target = principal.kind === "token" && principal.tokenId === token.id ? "self" : "org";
  const decision = await authorize(principal, action, {
    type: "token",
    orgId: token.orgId,
    tokenId: token.id,
    tokenTarget: target,
  });
  if (decision.allowed) return undefined;
  return authorizationDenied(c, decision);
}

export async function listAccessibleRepositories(orgId: string, c: Context<AppEnv>) {
  const rows = await listRepositoriesForOrg(orgId);
  const accessible = [];
  for (const repo of rows) {
    const response = await authorizeRepository(c, repo, "read");
    if (!response) accessible.push(repo);
  }
  return accessible;
}

export function doc(summary: string, tag: string) {
  return describeRoute({
    tags: [tag],
    summary,
    responses: {
      200: { description: "Success" },
      201: { description: "Created" },
      400: { description: "Bad request" },
      401: { description: "Authentication required" },
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  });
}
