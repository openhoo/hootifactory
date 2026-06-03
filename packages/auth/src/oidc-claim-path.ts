/**
 * OIDC claim extraction: walk a dotted claim path into an ID-token / UserInfo
 * payload and coerce the result into the shapes callers need (group lists,
 * trimmed string claims).
 */

import { z } from "zod";

const ClaimRecordSchema = z.record(z.string(), z.unknown());

function claimRecord(value: unknown): Record<string, unknown> | null {
  const parsed = ClaimRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function claimValue(payload: Record<string, unknown>, claimPath: string): unknown {
  let current: unknown = payload;
  for (const part of claimPath.split(".")) {
    const record = claimRecord(current);
    if (!part || !record || !(part in record)) return undefined;
    current = record[part];
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
