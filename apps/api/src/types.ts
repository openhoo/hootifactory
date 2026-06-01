import type { Principal } from "@hootifactory/auth";

export type AuthSource = "authorization" | "nugetApiKey" | "session" | "anonymous";

export type AppEnv = {
  Variables: {
    principal: Principal;
    authSource: AuthSource;
  };
};
