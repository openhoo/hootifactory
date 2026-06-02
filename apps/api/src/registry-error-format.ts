import type { OciErrorCode, RegistryError } from "@hootifactory/core";
import type { PackageFormat } from "@hootifactory/types";

const NON_OCI_ERROR_OBJECT_FORMATS = new Set<PackageFormat>(["go", "npm", "nuget", "pypi"]);

export function registryErrorResponseForFormat(
  format: PackageFormat,
  input: {
    status: number;
    code?: OciErrorCode;
    message: string;
    detail?: unknown;
    headers?: Record<string, string>;
  },
): Response {
  if (format === "cargo") {
    return Response.json(
      { errors: [{ detail: input.message }] },
      { status: input.status, headers: input.headers },
    );
  }
  if (NON_OCI_ERROR_OBJECT_FORMATS.has(format)) {
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

export function registryErrorToFormatResponse(format: PackageFormat, err: RegistryError): Response {
  return registryErrorResponseForFormat(format, {
    status: err.status,
    code: err.code,
    message: err.message,
    detail: err.detail,
  });
}
