import type { Principal } from "@hootifactory/auth";
import type { HttpRequestTelemetry } from "@hootifactory/observability";

export type AuthSource = "authorization" | "nugetApiKey" | "session" | "anonymous";
export type RegistryAuthFailure = "invalid_token";

export type AppEnv = {
  Variables: {
    principal: Principal;
    authSource: AuthSource;
    registryAuthFailure?: RegistryAuthFailure;
    httpTelemetry: HttpRequestTelemetry;
    requestId: string;
    correlationId: string;
  };
};
