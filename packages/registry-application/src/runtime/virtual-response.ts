import { type RegistryPlugin, registryErrorResponseForModule } from "@hootifactory/registry";

export function virtualNotFound(adapter: RegistryPlugin): Response {
  return registryErrorResponseForModule(adapter, {
    status: 404,
    code: "NOT_FOUND",
    message: "not found",
  });
}

/**
 * A member raised an UNEXPECTED (non-RegistryError) failure — a transient DB or
 * network fault, not a clean miss. Callers isolate the bad member and keep serving
 * the others, but use this synthesized 5xx as the fallback so that when EVERY
 * member fails the virtual repo surfaces a server error rather than a misleading
 * 404. (Registry error codes have no server-error member, and the status is what
 * clients distinguish on, so no `code` is set.)
 */
export function virtualMemberUnavailable(adapter: RegistryPlugin): Response {
  return registryErrorResponseForModule(adapter, {
    status: 502,
    message: "virtual repository member unavailable",
  });
}
