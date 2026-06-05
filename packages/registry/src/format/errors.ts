import type { RegistryErrorCode, RegistryError } from "@hootifactory/core";
import type { RegistryErrorResponseKind, RegistryPlugin } from "./adapter";

export function registryErrorResponseForKind(
  kind: RegistryErrorResponseKind,
  input: {
    status: number;
    code?: RegistryErrorCode;
    message: string;
    detail?: unknown;
    headers?: Record<string, string>;
  },
): Response {
  if (kind === "errorsDetail") {
    return Response.json(
      { errors: [{ detail: input.message }] },
      { status: input.status, headers: input.headers },
    );
  }
  if (kind === "singleError") {
    return Response.json(
      { error: input.message },
      { status: input.status, headers: input.headers },
    );
  }
  return Response.json(
    {
      errors: [
        {
          code: input.code ?? "DENIED",
          message: input.message,
          detail: input.detail ?? null,
        },
      ],
    },
    { status: input.status, headers: input.headers },
  );
}

export function registryErrorResponseForModule(
  module: Pick<RegistryPlugin, "errorResponseKind">,
  input: Parameters<typeof registryErrorResponseForKind>[1],
): Response {
  return registryErrorResponseForKind(module.errorResponseKind, input);
}

export function registryErrorToModuleResponse(
  module: Pick<RegistryPlugin, "errorResponseKind">,
  err: RegistryError,
): Response {
  return registryErrorResponseForModule(module, {
    status: err.status,
    code: err.code,
    message: err.message,
    detail: err.detail,
  });
}
