import { type Decision, httpStatusForDenial } from "@hootifactory/auth";
import { type z, zodIssueTree } from "@hootifactory/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types";
import { PaginationQuerySchema } from "./api-v1-route-schemas";

type ValidationResult<T> = { ok: true; data: T } | { ok: false; response: Response };

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
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return { ok: false, response: errorResponse(c, 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json") };
  }
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
