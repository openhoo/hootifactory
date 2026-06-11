import { describe, expect, test } from "bun:test";
import {
  validateVirtualMemberCandidate,
  validateVirtualMemberParent,
} from "./api-v1-virtual-members";

const virtualNpm = { id: "virtual", orgId: "org_a", moduleId: "npm", kind: "virtual" } as const;

describe("virtual repository member validation", () => {
  test("requires a virtual parent repository", () => {
    expect(
      validateVirtualMemberParent({ id: "repo", orgId: "org_a", moduleId: "npm", kind: "hosted" }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "members can only be added to virtual repositories",
    });
    expect(validateVirtualMemberParent(virtualNpm)).toEqual({ ok: true });
  });

  test("rejects missing, self-referential, cross-module, and non-hosted members", () => {
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
      validateVirtualMemberCandidate(virtualNpm, {
        id: "go",
        orgId: "org_a",
        moduleId: "go",
        kind: "hosted",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "virtual repository members must use the same registry module",
    });
    expect(
      validateVirtualMemberCandidate(virtualNpm, {
        id: "proxy",
        orgId: "org_a",
        moduleId: "npm",
        kind: "proxy",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "virtual repository members must be hosted repositories",
    });
  });

  test("rejects members from a different organization", () => {
    expect(
      validateVirtualMemberCandidate(virtualNpm, {
        id: "cross-org",
        orgId: "org_b",
        moduleId: "npm",
        kind: "hosted",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "virtual repository members must belong to the same organization",
    });
  });

  test("rejects cross-org members before disclosing module/kind mismatches", () => {
    // A cross-org candidate whose module and kind also differ must surface the org
    // mismatch, never the more specific module/kind errors, so those attributes stay
    // unobservable to a caller comparing against a same-org member.
    expect(
      validateVirtualMemberCandidate(virtualNpm, {
        id: "cross-org-proxy",
        orgId: "org_b",
        moduleId: "go",
        kind: "proxy",
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "virtual repository members must belong to the same organization",
    });
  });

  test("allows hosted repositories with the same module and organization", () => {
    const hosted = { id: "hosted", orgId: "org_a", moduleId: "npm", kind: "hosted" } as const;
    expect(validateVirtualMemberCandidate(virtualNpm, hosted)).toEqual({
      ok: true,
      member: hosted,
    });
  });
});
