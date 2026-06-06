const PUB_JSON_CONTENT_TYPE = "application/vnd.pub.v2+json";

/**
 * Build the pub error envelope `{"error":{"code","message"}}` with a status.
 * repository-spec-v2 returns errors as a JSON object (not a bare string) under
 * `application/vnd.pub.v2+json`; the pub client reads `error.message` off it. The
 * shared `singleError` renderer would emit `{"error":"<string>"}`, so every
 * protocol error — publish *and* GET-side not-found — is rendered here instead.
 */
export function pubErrorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "content-type": PUB_JSON_CONTENT_TYPE } },
  );
}

/** A pub-shaped 404 for a missing package/version/archive. */
export function pubNotFound(message: string): Response {
  return pubErrorResponse("NotFound", message, 404);
}

/** A pub-shaped 400 for a malformed package name / version / archive filename. */
export function pubBadRequest(message: string): Response {
  return pubErrorResponse("InvalidInput", message, 400);
}
