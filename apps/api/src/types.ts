import type { Principal } from "@hootifactory/auth";
import type { HttpRequestTelemetry } from "@hootifactory/observability";
import type { RegistryAuthFailure } from "@hootifactory/registry-application/runtime";

export type AuthSource = "authorization" | "registryApiKey" | "session" | "anonymous";
export type { RegistryAuthFailure };

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
