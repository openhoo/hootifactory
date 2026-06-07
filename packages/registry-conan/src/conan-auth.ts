import { Errors, type RegistryRequestContext } from "@hootifactory/registry";

/**
 * The capabilities banner returned on `GET /v1/ping`. Conan clients read the
 * `X-Conan-Server-Capabilities` header to decide which protocol features to use;
 * advertising `revisions` is what enables the v2 revision-addressed endpoints.
 *
 * We advertise only what the route table actually serves:
 *   - `revisions`: the v2 revision-addressed recipe/package endpoints.
 *   - `complex_search`: the `GET /v2/conans/search` recipe-search endpoint and
 *     the per-recipe package-search endpoints.
 * `checksum_deploy` is deliberately NOT advertised: we have no SHA1-keyed dedup
 * probe handler, and the client's empty-body `X-Checksum-Deploy` PUT would hit
 * the upload handler's empty-body rejection and fatally abort the upload.
 */
export const CONAN_SERVER_CAPABILITIES = ["complex_search", "revisions"];

/** `GET /v1/ping` — liveness + capability advertisement. */
export function conanPing(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "x-conan-server-capabilities": CONAN_SERVER_CAPABILITIES.join(","),
      "x-conan-server-version": "1.0.0",
    },
  });
}

/** A short, opaque label for the authenticated principal (for diagnostics only). */
function principalLabel(ctx: RegistryRequestContext): string {
  const principal = ctx.principal;
  if (principal.kind === "user") return principal.username;
  if (principal.kind === "registryToken") return principal.subject;
  if (principal.kind === "token") {
    return principal.ownerUsername ?? principal.tokenName ?? `token:${principal.tokenId}`;
  }
  return "anonymous";
}

/**
 * Extract the bearer-able credential the client presented. Conan first calls
 * `authenticate` with HTTP Basic (username + the user's hootifactory token as the
 * password) and expects a token string back, which it then sends as `Bearer` on
 * every subsequent request. hootifactory authenticates the principal before this
 * handler runs and accepts the same credential as a Bearer token, so we echo the
 * presented credential straight back rather than minting a second token format.
 */
function presentedCredential(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() === "basic") {
    let decoded: string;
    try {
      decoded = atob(value);
    } catch {
      return null;
    }
    const sep = decoded.indexOf(":");
    // Basic is `user:password`; the password carries the bearer-able token.
    const password = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    return password.length > 0 ? password : null;
  }
  return null;
}

/**
 * `POST /v2/users/authenticate` — exchange Basic credentials for a bearer token.
 * The platform has already authenticated the principal; an anonymous principal
 * means the credentials were missing/invalid, so we reject with a bearer
 * challenge. Otherwise we hand back the same credential for reuse as `Bearer`.
 */
export function conanAuthenticate(req: Request, ctx: RegistryRequestContext): Response {
  if (ctx.principal.kind === "anonymous") throw Errors.unauthorized();
  const token = presentedCredential(req);
  if (!token) throw Errors.unauthorized();
  return new Response(token, {
    status: 200,
    // The body is a credential; never let intermediaries or clients persist it.
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * `GET /v2/users/check_credentials` — confirm the bearer token is still valid.
 * Reaching here with a non-anonymous principal means the platform accepted it.
 */
export function conanCheckCredentials(ctx: RegistryRequestContext): Response {
  if (ctx.principal.kind === "anonymous") throw Errors.unauthorized();
  return new Response(principalLabel(ctx), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
