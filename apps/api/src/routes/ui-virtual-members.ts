import type { RepositoryRow } from "./ui-repository-access";

type VirtualMemberRepo = Pick<RepositoryRow, "id" | "format" | "kind">;

type ValidationResult = { ok: true } | { ok: false; status: 400 | 404; error: string };

type CandidateValidationResult<T extends VirtualMemberRepo> =
  | { ok: true; member: T }
  | { ok: false; status: 400 | 404; error: string };

export function validateVirtualMemberParent(parent: VirtualMemberRepo): ValidationResult {
  if (parent.kind !== "virtual") {
    return {
      ok: false,
      status: 400,
      error: "members can only be added to virtual repositories",
    };
  }
  return { ok: true };
}

export function validateVirtualMemberCandidate<T extends VirtualMemberRepo>(
  parent: VirtualMemberRepo,
  member: T | undefined,
): CandidateValidationResult<T> {
  if (!member) return { ok: false, status: 404, error: "member repository not found" };
  if (member.id === parent.id) {
    return {
      ok: false,
      status: 400,
      error: "virtual repositories cannot include themselves",
    };
  }
  if (member.format !== parent.format) {
    return {
      ok: false,
      status: 400,
      error: "virtual repository members must use the same format",
    };
  }
  if (member.kind !== "hosted") {
    return {
      ok: false,
      status: 400,
      error: "virtual repository members must be hosted repositories",
    };
  }
  return { ok: true, member };
}
