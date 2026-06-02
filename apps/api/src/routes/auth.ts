import { env } from "@hootifactory/config";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { registerLocalAuthRoutes } from "./auth-local-routes";
import { registerOidcRoutes } from "./auth-oidc-routes";
import { registerPasswordResetRoutes } from "./auth-password-reset-routes";

export const authRouter = new Hono<AppEnv>();

authRouter.get("/methods", (c) =>
  c.json({
    password: true,
    registration: env.AUTH_ALLOW_REGISTRATION,
    oidc: env.AUTH_OIDC_ENABLED
      ? {
          enabled: true,
          name: env.AUTH_OIDC_NAME,
          startUrl: "/api/auth/oidc/start",
        }
      : { enabled: false },
  }),
);

registerOidcRoutes(authRouter);
registerPasswordResetRoutes(authRouter);
registerLocalAuthRoutes(authRouter);
