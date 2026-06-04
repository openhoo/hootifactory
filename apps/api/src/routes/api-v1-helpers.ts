import {
  authorize,
  createRequestAuthorizer,
  type Decision,
  httpStatusForDenial,
} from "@hootifactory/auth";
import {
  V1ArtifactIdParamsSchema,
  V1AssetListQuerySchema,
  V1ErrorResponseSchema,
  V1OrgIdParamsSchema,
  V1OrgTokenParamsSchema,
  V1PackageIdParamsSchema,
  V1PackageVersionParamsSchema,
  V1PaginationQuerySchema,
  V1RepoIdParamsSchema,
  V1TokenIdParamsSchema,
} from "@hootifactory/contracts";
import { z, zodIssueTree } from "@hootifactory/core";
import type { ResolvedRepo } from "@hootifactory/registry";
import {
  type ArtifactWithRepositoryRow,
  getArtifactWithRepository,
  getPackageWithRepository,
  type PackageWithRepositoryRow,
} from "@hootifactory/registry-application/inventory";
import {
  countRepositoriesForOrg,
  getRepositoryById,
  listRepositoriesForOrg,
} from "@hootifactory/registry-application/repositories";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute } from "hono-openapi";
import type { AppEnv } from "../types";

type ApiV1Action = "read" | "write" | "delete" | "admin";
type ValidationResult<T> = { ok: true; data: T } | { ok: false; response: Response };

export const PaginationQuerySchema = V1PaginationQuerySchema;
export const OrgIdParamsSchema = V1OrgIdParamsSchema;
export const RepoIdParamsSchema = V1RepoIdParamsSchema;
export const PackageIdParamsSchema = V1PackageIdParamsSchema;
export const PackageVersionParamsSchema = V1PackageVersionParamsSchema;
export const ArtifactIdParamsSchema = V1ArtifactIdParamsSchema;
export const TokenIdParamsSchema = V1TokenIdParamsSchema;
export const OrgTokenParamsSchema = V1OrgTokenParamsSchema;
export const AssetListQuerySchema = V1AssetListQuerySchema;

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

export async function authorizeArtifactFindings(
  c: Context<AppEnv>,
  row: ArtifactWithRepositoryRow,
) {
  const decision = await authorize(c.get("principal"), "read", {
    type: "policy",
    orgId: row.repo.orgId,
    repositoryId: row.repo.id,
    repositoryName: row.repo.name,
    policy: "scan",
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

export async function listAccessibleRepositories(
  orgId: string,
  c: Context<AppEnv>,
  pagination: { limit: number; offset: number },
) {
  const requestAuthorize = createRequestAuthorizer(c.get("principal"));
  const orgDecision = await requestAuthorize("read", { type: "org", orgId });
  if (orgDecision.allowed) {
    const [total, rows] = await Promise.all([
      countRepositoriesForOrg(orgId),
      listRepositoriesForOrg(orgId, pagination),
    ]);
    return { rows, total };
  }

  const rows = await listRepositoriesForOrg(orgId);
  const accessible = [];
  for (const repo of rows) {
    const decision = await requestAuthorize("read", {
      type: "repository",
      orgId: repo.orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
      visibility: repo.visibility,
    });
    if (decision.allowed) accessible.push(repo);
  }
  return {
    rows: accessible.slice(pagination.offset, pagination.offset + pagination.limit),
    total: accessible.length,
  };
}

type OpenApiSchemaObject = Record<string, unknown>;
type OpenApiResponseObject = {
  description: string;
  content?: Record<string, { schema: OpenApiSchemaObject }>;
};
type ApiV1DocResponse = {
  description: string;
  schema?: z.ZodType;
  status?: ContentfulStatusCode;
};
type ApiV1DocOptions = {
  operationId: string;
  summary: string;
  tag: string;
  description?: string;
  pathParams?: z.ZodType;
  query?: z.ZodType;
  requestBody?: {
    description?: string;
    required?: boolean;
    schema: z.ZodType;
  };
  response: ApiV1DocResponse;
  errorStatuses?: ContentfulStatusCode[];
  extraResponses?: Record<number, ApiV1DocResponse>;
};

function schemaObject(schema: z.ZodType): OpenApiSchemaObject {
  const json = z.toJSONSchema(schema, { io: "input" }) as OpenApiSchemaObject;
  delete json.$schema;
  return json;
}

function responseObject(description: string, schema?: z.ZodType): OpenApiResponseObject {
  if (!schema) return { description };
  return {
    description,
    content: {
      "application/json": {
        schema: schemaObject(schema),
      },
    },
  };
}

function parameterDocs(location: "path" | "query", schema: z.ZodType) {
  const json = schemaObject(schema);
  const properties = (json.properties ?? {}) as Record<string, OpenApiSchemaObject>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    description: typeof property.description === "string" ? property.description : undefined,
    schema: property,
  }));
}

export function doc(options: ApiV1DocOptions) {
  const successStatus = options.response.status ?? 200;
  const responses: Record<string, OpenApiResponseObject> = {
    [successStatus]: responseObject(options.response.description, options.response.schema),
  };
  const errorStatuses = options.errorStatuses ?? [400, 401, 403, 404];
  for (const status of errorStatuses) {
    responses[status] ??= responseObject(
      status === 400
        ? "Bad request"
        : status === 401
          ? "Authentication required"
          : status === 403
            ? "Forbidden"
            : status === 404
              ? "Not found"
              : "Error",
      V1ErrorResponseSchema,
    );
  }
  for (const [status, response] of Object.entries(options.extraResponses ?? {})) {
    const numericStatus = Number(status);
    responses[status] = responseObject(
      response.description,
      response.schema ?? (numericStatus >= 400 ? V1ErrorResponseSchema : undefined),
    );
  }

  const parameters = [
    ...(options.pathParams ? parameterDocs("path", options.pathParams) : []),
    ...(options.query ? parameterDocs("query", options.query) : []),
  ];

  return describeRoute({
    tags: [options.tag],
    operationId: options.operationId,
    summary: options.summary,
    description: options.description,
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody: options.requestBody
      ? {
          description: options.requestBody.description,
          required: options.requestBody.required ?? true,
          content: {
            "application/json": {
              schema: schemaObject(options.requestBody.schema),
            },
          },
        }
      : undefined,
    responses,
  });
}
