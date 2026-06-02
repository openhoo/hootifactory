import type { FormatAdapter } from "@hootifactory/core";
import { registryErrorResponseForFormat } from "./registry-error-format";

export function virtualNotFound(adapter: FormatAdapter): Response {
  return registryErrorResponseForFormat(adapter.format, {
    status: 404,
    code: "NOT_FOUND",
    message: "not found",
  });
}
