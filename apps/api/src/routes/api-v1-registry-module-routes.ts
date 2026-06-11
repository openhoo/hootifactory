import { V1RegistryModulesResponseSchema } from "@hootifactory/contracts";
import { registryPlugins } from "@hootifactory/registry";
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { dataResponse, doc } from "./api-v1-helpers";

export function registerApiV1RegistryModuleRoutes(apiV1Router: Hono<AppEnv>) {
  apiV1Router.get(
    "/registry-modules",
    doc({
      operationId: "listRegistryModules",
      summary: "List registry modules",
      tag: "Registry modules",
      description: "Lists the registry protocol modules installed on this instance.",
      response: {
        description: "Installed registry modules.",
        schema: V1RegistryModulesResponseSchema,
      },
    }),
    (c) =>
      dataResponse(c, {
        modules: registryPlugins.all().map((module) => ({
          id: module.id,
          displayName: module.displayName,
          mountSegment: module.mountSegment,
          capabilities: module.capabilities,
        })),
      }),
  );
}
