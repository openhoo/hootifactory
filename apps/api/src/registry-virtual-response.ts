import type { RegistryPlugin } from "@hootifactory/registry";
import { registryErrorResponseForModule } from "./registry-error-format";

export function virtualNotFound(adapter: RegistryPlugin): Response {
  return registryErrorResponseForModule(adapter, {
    status: 404,
    code: "NOT_FOUND",
    message: "not found",
  });
}
