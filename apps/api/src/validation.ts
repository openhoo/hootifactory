import { errorMessage, type ZodType, z, zodIssueTree } from "@hootifactory/core";
import type { Context } from "hono";
import type { AppEnv } from "./types";

type ValidationResult<T> = { ok: true; data: T } | { ok: false; response: Response };

function validationResponse(c: Context<AppEnv>, message: string, error: z.ZodError): Response {
  return c.json({ error: message, issues: zodIssueTree(error) }, 400);
}

export function validateInput<T extends ZodType>(
  c: Context<AppEnv>,
  schema: T,
  input: unknown,
  message = "invalid request",
): ValidationResult<z.output<T>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, response: validationResponse(c, message, parsed.error) };
}

export function validateParams<T extends ZodType>(
  c: Context<AppEnv>,
  schema: T,
  message = "invalid path parameters",
): ValidationResult<z.output<T>> {
  return validateInput(c, schema, c.req.param(), message);
}

export async function validateJsonBody<T extends ZodType>(
  c: Context<AppEnv>,
  schema: T,
  message = "invalid request body",
): Promise<ValidationResult<z.output<T>>> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return { ok: false, response: c.json({ error: "Content-Type must be application/json" }, 415) };
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid JSON body" }, 400) };
  }
  return validateInput(c, schema, body, message);
}

export { errorMessage };

export const uuidParam = z.uuid();

export const uuidParams = {
  orgId: z.strictObject({ orgId: uuidParam }),
  repoId: z.strictObject({ repoId: uuidParam }),
  packageId: z.strictObject({ packageId: uuidParam }),
  artifactId: z.strictObject({ artifactId: uuidParam }),
  orgToken: z.strictObject({ orgId: uuidParam, tokenId: uuidParam }),
};
