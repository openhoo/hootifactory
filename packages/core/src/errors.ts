/** OCI distribution error codes (also reused as a generic registry error envelope). */
export type OciErrorCode =
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNKNOWN"
  | "NAME_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "UNAUTHORIZED"
  | "DENIED"
  | "UNSUPPORTED"
  | "TOOMANYREQUESTS"
  | "NOT_FOUND";

export class RegistryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: OciErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RegistryError";
  }

  toResponse(extraHeaders?: Record<string, string>): Response {
    return Response.json(
      { errors: [{ code: this.code, message: this.message, detail: this.detail ?? null }] },
      { status: this.status, headers: extraHeaders },
    );
  }
}

export const Errors = {
  blobUnknown: (detail?: unknown) =>
    new RegistryError(404, "BLOB_UNKNOWN", "blob unknown to registry", detail),
  blobUploadUnknown: (detail?: unknown) =>
    new RegistryError(404, "BLOB_UPLOAD_UNKNOWN", "blob upload unknown to registry", detail),
  manifestUnknown: (detail?: unknown) =>
    new RegistryError(404, "MANIFEST_UNKNOWN", "manifest unknown to registry", detail),
  manifestInvalid: (detail?: unknown) =>
    new RegistryError(400, "MANIFEST_INVALID", "manifest invalid", detail),
  manifestBlobUnknown: (detail?: unknown) =>
    new RegistryError(
      404,
      "MANIFEST_BLOB_UNKNOWN",
      "manifest references a blob unknown to registry",
      detail,
    ),
  nameUnknown: (detail?: unknown) =>
    new RegistryError(404, "NAME_UNKNOWN", "repository name not known to registry", detail),
  nameInvalid: (detail?: unknown) =>
    new RegistryError(400, "NAME_INVALID", "invalid repository name", detail),
  digestInvalid: (detail?: unknown) =>
    new RegistryError(
      400,
      "DIGEST_INVALID",
      "provided digest did not match uploaded content",
      detail,
    ),
  sizeInvalid: (detail?: unknown) =>
    new RegistryError(400, "SIZE_INVALID", "provided length did not match content length", detail),
  unauthorized: (detail?: unknown) =>
    new RegistryError(401, "UNAUTHORIZED", "authentication required", detail),
  denied: (detail?: unknown) =>
    new RegistryError(403, "DENIED", "requested access to the resource is denied", detail),
  unsupported: (detail?: unknown) =>
    new RegistryError(400, "UNSUPPORTED", "the operation is unsupported", detail),
  notFound: (detail?: unknown) => new RegistryError(404, "NOT_FOUND", "not found", detail),
  // 403, not 413: a quota exhaustion is a persistent account-level refusal, not an
  // oversized-request-body condition that a smaller retry would resolve.
  quotaExceeded: (detail?: unknown) =>
    new RegistryError(403, "DENIED", "storage quota exceeded", detail),
} as const;

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). Drizzle wraps
 * the underlying PostgresError in `.cause`, so we walk the cause chain.
 */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i++) {
    const rec = e as { errno?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (rec.errno === 23505 || rec.errno === "23505" || rec.code === "23505") return true;
    if (typeof rec.message === "string" && rec.message.includes("duplicate key value")) return true;
    e = rec.cause;
  }
  return false;
}
