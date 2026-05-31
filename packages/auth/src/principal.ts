import type { TokenScope } from "@hootifactory/db";
import type { RoleName } from "./permissions";

/** Normalized identity after authentication; every adapter converges on this. */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; username: string }
  | {
      kind: "token";
      tokenId: string;
      orgId: string;
      ownerUserId: string | null;
      scopes: TokenScope[];
      role: RoleName | null;
      isRobot: boolean;
    };

export type ResourceType = "repository" | "org" | "system";

export interface ResourceRef {
  type: ResourceType;
  /** Resolved from the DB (repo -> org), NEVER trusted from the request path. */
  orgId?: string;
  repositoryId?: string;
  /** Used for token-scope matching, e.g. "acme/app" or "@scope/pkg". */
  repositoryName?: string;
  visibility?: "private" | "public";
}

export type DenialCode =
  | "unauthenticated"
  | "cross_org"
  | "not_member"
  | "insufficient_scope"
  | "insufficient_role"
  | "forbidden";

export interface Decision {
  allowed: boolean;
  code?: DenialCode;
  reason?: string;
}

export function isAnonymous(p: Principal): p is { kind: "anonymous" } {
  return p.kind === "anonymous";
}

/** 401 for unauthenticated (triggers client re-auth), 403 otherwise. */
export function httpStatusForDenial(d: Decision): 401 | 403 {
  return d.code === "unauthenticated" ? 401 : 403;
}
