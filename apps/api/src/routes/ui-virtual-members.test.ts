import { describe, expect, test } from "bun:test";
import { validateVirtualMemberCandidate, validateVirtualMemberParent } from "./ui-virtual-members";

const virtualNpm = { id: "virtual", format: "npm", kind: "virtual" } as const;

describe("virtual repository member validation", () => {
  test("requires a virtual parent repository", () => {
    expect(validateVirtualMemberParent({ id: "repo", format: "npm", kind: "hosted" })).toEqual({
      ok: false,
      status: 400,
      error: "members can only be added to virtual repositories",
    });
    expect(validateVirtualMemberParent(virtualNpm)).toEqual({ ok: true });
  });

  test("rejects missing, self-referential, cross-format, and non-hosted members", () => {
    expect(validateVirtualMemberCandidate(virtualNpm, undefined)).toEqual({
      ok: false,
      status: 404,
      error: "member repository not found",
    });
    expect(validateVirtualMemberCandidate(virtualNpm, virtualNpm)).toEqual({
      ok: false,
      status: 400,
      error: "virtual repositories cannot include themselves",
    });
    expect(
      validateVirtualMemberCandidate(virtualNpm, { id: "go", format: "go", kind: "hosted" }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "virtual repository members must use the same format",
    });
    expect(
      validateVirtualMemberCandidate(virtualNpm, { id: "proxy", format: "npm", kind: "proxy" }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "virtual repository members must be hosted repositories",
    });
  });

  test("allows hosted repositories with the same format", () => {
    const hosted = { id: "hosted", format: "npm", kind: "hosted" } as const;
    expect(validateVirtualMemberCandidate(virtualNpm, hosted)).toEqual({
      ok: true,
      member: hosted,
    });
  });
});
