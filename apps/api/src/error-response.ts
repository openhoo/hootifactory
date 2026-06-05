import { asError, HttpError } from "@hootifactory/core";

const INTERNAL_ERROR_CODE = "INTERNAL";
const INTERNAL_ERROR_MESSAGE = "internal server error";

export type ErrorLogLevel = "warn" | "error";

export interface ApplicationErrorResponsePlan {
  body: unknown;
  code: string;
  error: Error;
  logLevel: ErrorLogLevel;
  logMessage: string;
  message: string;
  status: number;
}

interface PlanApplicationErrorResponseInput {
  path: string;
  requestId?: string;
}

function isApiV1Path(path: string): boolean {
  return path === "/api/v1" || path.startsWith("/api/v1/");
}

function safeErrorStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export function planApplicationErrorResponse(
  err: unknown,
  input: PlanApplicationErrorResponseInput,
): ApplicationErrorResponsePlan {
  const error = asError(err);
  const isHttpError = err instanceof HttpError;
  const status = safeErrorStatus(isHttpError ? err.status : 500);
  const code = isHttpError ? err.code : INTERNAL_ERROR_CODE;
  const message = isHttpError && err.expose ? err.message : INTERNAL_ERROR_MESSAGE;
  // App routes (api/v1, ui, auth, health) all use the object error envelope the web
  // client parses ({ error: { code, message } }); only the registry/OCI paths use the
  // array envelope, and those are handled separately (RegistryError / request-safety).
  const body = {
    error: { code, message },
    ...(!isApiV1Path(input.path) && input.requestId ? { requestId: input.requestId } : {}),
  };

  return {
    body,
    code,
    error,
    logLevel: status >= 500 ? "error" : "warn",
    logMessage: isHttpError ? "application error response" : "unhandled error",
    message,
    status,
  };
}
