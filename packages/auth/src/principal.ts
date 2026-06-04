import type { Decision, Principal } from "@hootifactory/types";

export type {
  Decision,
  DenialCode,
  Principal,
  RegistryAccess,
  ResourceRef,
  ResourceType,
} from "@hootifactory/types";

export function isAnonymous(p: Principal): p is { kind: "anonymous" } {
  return p.kind === "anonymous";
}

/** 401 for unauthenticated (triggers client re-auth), 403 otherwise. */
export function httpStatusForDenial(d: Decision): 401 | 403 {
  return d.code === "unauthenticated" ? 401 : 403;
}
