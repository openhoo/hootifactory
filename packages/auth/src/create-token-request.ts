import type { RoleName, TokenGrant, TokenType } from "@hootifactory/types";

export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface CreateApiTokenRequestInput {
  name: string;
  type?: TokenType;
  grants?: TokenGrant[];
  role?: RoleName;
  expiresAt?: Date | null;
}

export interface ResolvedCreateApiTokenRequest {
  name: string;
  type: TokenType;
  grants: TokenGrant[];
  requestedRole?: RoleName;
  expiresAt: Date | null;
}

export function resolveCreateApiTokenRequest(
  body: CreateApiTokenRequestInput,
  now = new Date(),
): ResolvedCreateApiTokenRequest {
  const grants = body.grants ?? [];
  const requestedRole = body.role ?? (grants.length > 0 ? undefined : "developer");
  const expiresAt =
    body.expiresAt === undefined ? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS) : body.expiresAt;

  return {
    name: body.name,
    type: body.type ?? "personal",
    grants,
    requestedRole,
    expiresAt,
  };
}
