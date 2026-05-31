import { describe, expect, test } from "bun:test";
import { can } from "./can";
import { roleAllows } from "./permissions";
import { httpStatusForDenial, type Principal } from "./principal";
import { patternMatches, scopeGrants } from "./scope";

const anon: Principal = { kind: "anonymous" };
const user: Principal = { kind: "user", userId: "u1", username: "alice" };
const tokenScoped: Principal = {
  kind: "token",
  tokenId: "t1",
  orgId: "orgA",
  ownerUserId: "u1",
  scopes: [{ repository: "acme/*", actions: ["read", "write"] }],
  role: null,
  isRobot: false,
};
const tokenRobot: Principal = {
  kind: "token",
  tokenId: "t2",
  orgId: "orgA",
  ownerUserId: null,
  scopes: [],
  role: "developer",
  isRobot: true,
};

describe("role matrix", () => {
  test("viewer reads only", () => {
    expect(roleAllows("viewer", "read")).toBe(true);
    expect(roleAllows("viewer", "write")).toBe(false);
  });
  test("developer reads + writes, not delete", () => {
    expect(roleAllows("developer", "write")).toBe(true);
    expect(roleAllows("developer", "delete")).toBe(false);
  });
  test("admin/owner can delete + admin", () => {
    expect(roleAllows("admin", "delete")).toBe(true);
    expect(roleAllows("owner", "admin")).toBe(true);
  });
});

describe("scope matching", () => {
  test("patterns", () => {
    expect(patternMatches("*", "anything/here")).toBe(true);
    expect(patternMatches("acme/*", "acme")).toBe(true);
    expect(patternMatches("acme/*", "acme/app")).toBe(true);
    expect(patternMatches("acme/*", "other/app")).toBe(false);
    expect(patternMatches("acme/app", "acme/app")).toBe(true);
    expect(patternMatches("acme/app", "acme/app2")).toBe(false);
  });
  test("scopeGrants", () => {
    const scopes = [{ repository: "acme/*", actions: ["read"] as const }];
    expect(scopeGrants(scopes as never, "acme/app", "read")).toBe(true);
    expect(scopeGrants(scopes as never, "acme/app", "write")).toBe(false);
    expect(scopeGrants(scopes as never, "other/app", "read")).toBe(false);
  });
});

describe("can() — anonymous", () => {
  test("public repo read allowed", () => {
    const d = can({
      principal: anon,
      action: "read",
      resource: { type: "repository", visibility: "public", orgId: "orgA" },
    });
    expect(d.allowed).toBe(true);
  });
  test("private repo read => 401 unauthenticated", () => {
    const d = can({
      principal: anon,
      action: "read",
      resource: { type: "repository", visibility: "private", orgId: "orgA" },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("unauthenticated");
    expect(httpStatusForDenial(d)).toBe(401);
  });
  test("public repo write => 401 (writes always need auth)", () => {
    const d = can({
      principal: anon,
      action: "write",
      resource: { type: "repository", visibility: "public", orgId: "orgA" },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("unauthenticated");
  });
});

describe("can() — token org boundary", () => {
  test("cross-org token => 403 cross_org", () => {
    const d = can({
      principal: tokenScoped,
      action: "read",
      resource: { type: "repository", orgId: "orgB", repositoryName: "acme/app" },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("cross_org");
    expect(httpStatusForDenial(d)).toBe(403);
  });
  test("same-org scoped token: grant within scope, deny outside", () => {
    const ok = can({
      principal: tokenScoped,
      action: "write",
      resource: { type: "repository", orgId: "orgA", repositoryName: "acme/app" },
    });
    expect(ok.allowed).toBe(true);

    const denied = can({
      principal: tokenScoped,
      action: "write",
      resource: { type: "repository", orgId: "orgA", repositoryName: "other/app" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("insufficient_scope");
  });
  test("robot token uses its role", () => {
    const d = can({
      principal: tokenRobot,
      action: "write",
      resource: { type: "repository", orgId: "orgA", repositoryName: "x/y" },
    });
    expect(d.allowed).toBe(true);
    const del = can({
      principal: tokenRobot,
      action: "delete",
      resource: { type: "repository", orgId: "orgA", repositoryName: "x/y" },
    });
    expect(del.allowed).toBe(false);
  });
  test("scoped token cannot escalate on an org-level resource (no repositoryName)", () => {
    // Even if the owner is an org admin/owner, a scoped token must not inherit
    // that role on a resource its scopes can't match (privilege-escalation guard).
    const d = can({
      principal: tokenScoped,
      action: "admin",
      resource: { type: "org", orgId: "orgA" },
      effectiveRole: "owner",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("insufficient_scope");
  });
});

describe("can() — user", () => {
  test("non-member => 403 not_member", () => {
    const d = can({
      principal: user,
      action: "read",
      resource: { type: "repository", orgId: "orgA" },
      effectiveRole: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("not_member");
    expect(httpStatusForDenial(d)).toBe(403);
  });
  test("member role gates action", () => {
    expect(
      can({
        principal: user,
        action: "write",
        resource: { type: "repository", orgId: "orgA" },
        effectiveRole: "developer",
      }).allowed,
    ).toBe(true);
    expect(
      can({
        principal: user,
        action: "delete",
        resource: { type: "repository", orgId: "orgA" },
        effectiveRole: "developer",
      }).allowed,
    ).toBe(false);
  });
});
