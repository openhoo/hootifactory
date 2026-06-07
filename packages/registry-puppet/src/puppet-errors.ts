const PUPPET_JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Build the Puppet Forge error envelope `{"message","errors"}` with a status.
 * The Forge v3 API returns errors as a JSON object whose `message` the puppet
 * client surfaces, plus an `errors` array of human-readable strings. The shared
 * `singleError` renderer would emit `{"error":"<string>"}`, so every protocol
 * error — publish *and* GET-side not-found — is rendered here instead.
 */
export function puppetErrorResponse(message: string, status: number): Response {
  return Response.json(
    { message, errors: [message] },
    { status, headers: { "content-type": PUPPET_JSON_CONTENT_TYPE } },
  );
}

/** A Forge-shaped 404 for a missing module/release/file. */
export function puppetNotFound(message: string): Response {
  return puppetErrorResponse(message, 404);
}

/** A Forge-shaped 400 for a malformed slug / version / filename. */
export function puppetBadRequest(message: string): Response {
  return puppetErrorResponse(message, 400);
}
