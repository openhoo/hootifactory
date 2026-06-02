import type { TokenGrant, TokenScope } from "@hootifactory/db";
import type { RoleName } from "./permissions";

/** An OCI Bearer-token access claim (already authorized at /token issue time). */
export interface RegistryAccess {
  type: string; // "repository"
  name: string; // full docker name, e.g. "acme/containers/myimg"
  actions: string[]; // ["pull","push","delete"] (or ["*"])
}

/** Normalized identity after authentication; every adapter converges on this. */
export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; username: string }
  | {
      kind: "token";
      tokenId: string;
      tokenName?: string;
      orgId: string;
      ownerUserId: string | null;
      ownerUsername?: string | null;
      grants: TokenGrant[];
      /** Legacy alias derived from repository grants for older UI/API callers. */
      scopes: TokenScope[];
      role: RoleName | null;
      isRobot: boolean;
    }
  | {
      // Short-lived OCI Bearer JWT — its access claims were authorized by /token.
      kind: "registryToken";
      subject: string;
      access: RegistryAccess[];
    };

export type ResourceType =
  | "repository"
  | "org"
  | "package"
  | "artifact"
  | "policy"
  | "token"
  | "system";

export interface ResourceRef {
  type: ResourceType;
  /** Resolved from the DB (repo -> org), NEVER trusted from the request path. */
  orgId?: string;
  repositoryId?: string;
  /** Used for token-scope matching, e.g. "acme/app" or "@scope/pkg". */
  repositoryName?: string;
  packageName?: string;
  artifactRef?: string;
  policy?: "scan" | "quota" | "retention" | "*";
  tokenTarget?: "self" | "org";
  tokenId?: string;
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
