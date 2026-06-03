import type { RegistryPlugin } from "@hootifactory/registry";
import { registryErrorResponseForFormat } from "./registry-error-format";

export function virtualNotFound(adapter: RegistryPlugin): Response {
  return registryErrorResponseForFormat(adapter.format, {
    status: 404,
    code: "NOT_FOUND",
    message: "not found",
  });
}
