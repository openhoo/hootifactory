import type { RoleName } from "@hootifactory/auth";
import type { CreateTokenBody, ParsedTokenScope } from "./ui-schemas";

export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type CreateTokenRequest = {
  name: string;
  type: "personal" | "robot";
  scopes: ParsedTokenScope[];
  requestedRole?: RoleName;
  expiresAt: Date | null;
};

export function resolveCreateTokenRequest(
  body: CreateTokenBody,
  now = new Date(),
): CreateTokenRequest {
  const requestedRole = body.role ?? (body.scopes.length > 0 ? undefined : "developer");
  const expiresAt =
    body.expiresAt === undefined ? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS) : body.expiresAt;

  return {
    name: body.name,
    type: body.type,
    scopes: body.scopes,
    requestedRole,
    expiresAt,
  };
}
