import type { Principal } from "@hootifactory/auth";

export type AuthSource = "authorization" | "nugetApiKey" | "session" | "anonymous";
export type RegistryAuthFailure = "invalid_token";

export type AppEnv = {
  Variables: {
    principal: Principal;
    authSource: AuthSource;
    registryAuthFailure?: RegistryAuthFailure;
    requestId: string;
    correlationId: string;
  };
};
