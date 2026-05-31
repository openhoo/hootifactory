import type { Principal } from "@hootifactory/auth";

export type AppEnv = {
  Variables: {
    principal: Principal;
  };
};
