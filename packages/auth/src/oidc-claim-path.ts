/**
 * OIDC claim extraction: walk a dotted claim path into an ID-token / UserInfo
 * payload and coerce the result into the shapes callers need (group lists,
 * trimmed string claims).
 */

function claimValue(payload: Record<string, unknown>, claimPath: string): unknown {
  let current: unknown = payload;
  for (const part of claimPath.split(".")) {
    if (!part || typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Extract group claims from an OIDC ID-token payload using the configured claim path. */
export function extractGroups(payload: Record<string, unknown>, groupClaim: string): string[] {
  const raw = claimValue(payload, groupClaim);
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === "string");
  if (typeof raw === "string") return [raw];
  return [];
}

export function extractStringClaim(
  payload: Record<string, unknown>,
  claimPath: string,
): string | null {
  const raw = claimValue(payload, claimPath);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
