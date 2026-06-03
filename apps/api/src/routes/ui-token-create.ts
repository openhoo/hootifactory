import type { RoleName } from "@hootifactory/auth";
import type { ParsedTokenGrant, V1CreateTokenRequest } from "@hootifactory/contracts";
import type { CreateTokenBody } from "./ui-schemas";

export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type CreateTokenRequest = {
  name: string;
  type: "personal" | "robot";
  grants: ParsedTokenGrant[];
  requestedRole?: RoleName;
  expiresAt: Date | null;
};

export function resolveCreateTokenRequest(
  body: CreateTokenBody | V1CreateTokenRequest,
  now = new Date(),
): CreateTokenRequest {
  const grants =
    "grants" in body && body.grants
      ? body.grants
      : "scopes" in body
        ? body.scopes.map(
            (scope): ParsedTokenGrant => ({
              resource: "repository",
              repository: scope.repository,
              actions: scope.actions,
            }),
          )
        : [];
  const requestedRole = body.role ?? (grants.length > 0 ? undefined : "developer");
  const expiresAt =
    body.expiresAt === undefined ? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS) : body.expiresAt;

  return {
    name: body.name,
    type: body.type,
    grants,
    requestedRole,
    expiresAt,
  };
}
