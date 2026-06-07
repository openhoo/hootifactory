/**
 * Build the Ansible Galaxy error envelope `{"errors":[{...}]}` with a status.
 * The v3 API returns errors as a list of objects carrying `code`/`detail`/`status`;
 * ansible-galaxy surfaces `detail`. This mirrors the module's `errorsDetail`
 * response kind for handler-level (publish + GET) errors.
 */
export function ansibleErrorResponse(code: string, detail: string, status: number): Response {
  return Response.json({ errors: [{ status: String(status), code, detail }] }, { status });
}

/** A galaxy-shaped 404 for a missing collection/version/artifact. */
export function ansibleNotFound(detail: string): Response {
  return ansibleErrorResponse("not_found", detail, 404);
}

/** A galaxy-shaped 400 for a malformed namespace / name / version / filename. */
export function ansibleBadRequest(detail: string): Response {
  return ansibleErrorResponse("invalid", detail, 400);
}

/** A galaxy-shaped 409 for a duplicate collection version on publish. */
export function ansibleConflict(detail: string): Response {
  return ansibleErrorResponse("conflict.collection_exists", detail, 409);
}
