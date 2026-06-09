import { describe, expect, test } from "bun:test";
import { can } from "./can";
import type { PermissionGrantRow } from "./permission-grants";
import { permissionImplies } from "./permissions";
import { httpStatusForDenial, type Principal } from "./principal";
import { patternMatches } from "./scope";

const anon: Principal = { kind: "anonymous" };
const user: Principal = { kind: "user", userId: "u1", username: "alice" };
const tokenScoped: Principal = {
  kind: "token",
  tokenId: "t1",
  orgId: "orgA",
  ownerUserId: "u1",
  grants: [],
  isRobot: false,
};

function grant(overrides: Partial<PermissionGrantRow> = {}): PermissionGrantRow {
  return {
    id: "g1",
    orgId: "orgA",
    userId: "u1",
    groupId: null,
    tokenId: null,
    permission: "repository.write",
    repositoryId: null,
    repositoryPattern: "acme/*",
    packagePattern: null,
    artifactPattern: null,
    policy: null,
    tokenTarget: null,
    targetTokenId: null,
    grantedByUserId: null,
    source: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("permission matrix", () => {
  test("system admin implies every permission", () => {
    expect(permissionImplies("system.admin", "repository.delete")).toBe(true);
    expect(permissionImplies("system.admin", "user.deactivate")).toBe(true);
  });

  test("write grants read but not delete", () => {
    expect(permissionImplies("repository.write", "repository.read")).toBe(true);
    expect(permissionImplies("repository.write", "repository.delete")).toBe(false);
  });

  test("repository grants imply package and artifact permissions", () => {
    expect(permissionImplies("repository.write", "package.write")).toBe(true);
    expect(permissionImplies("repository.delete", "artifact.delete")).toBe(true);
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
});

describe("can() — anonymous", () => {
  test("public repository, package, and artifact reads are allowed", () => {
    expect(
      can({
        principal: anon,
        action: "read",
        resource: { type: "repository", visibility: "public", orgId: "orgA" },
      }).allowed,
    ).toBe(true);
    expect(
      can({
        principal: anon,
        permission: "package.read",
        resource: {
          type: "package",
          visibility: "public",
          orgId: "orgA",
          repositoryName: "acme/app",
          packageName: "demo",
        },
      }).allowed,
    ).toBe(true);
  });

  test("public visibility does not make policy metadata anonymous-readable", () => {
    const d = can({
      principal: anon,
      action: "read",
      resource: {
        type: "policy",
        policy: "scan",
        visibility: "public",
        orgId: "orgA",
        repositoryName: "acme/app",
      },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("unauthenticated");
  });

  test("private reads and writes require authentication", () => {
    const d = can({
      principal: anon,
      action: "read",
      resource: { type: "repository", visibility: "private", orgId: "orgA" },
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("unauthenticated");
    expect(httpStatusForDenial(d)).toBe(401);
  });
});

describe("can() — token and user grants", () => {
  test("tokens are bound to their issuing organization", () => {
    const d = can({
      principal: tokenScoped,
      action: "read",
      resource: { type: "repository", orgId: "orgB", repositoryName: "acme/app" },
      grants: [grant({ tokenId: "t1", userId: null })],
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("cross_org");
    expect(httpStatusForDenial(d)).toBe(403);
  });

  test("matching scoped grants allow and mismatched scopes deny", () => {
    const ok = can({
      principal: tokenScoped,
      action: "write",
      resource: { type: "repository", orgId: "orgA", repositoryName: "acme/app" },
      grants: [grant({ tokenId: "t1", userId: null })],
    });
    expect(ok.allowed).toBe(true);

    const denied = can({
      principal: tokenScoped,
      action: "write",
      resource: { type: "repository", orgId: "orgA", repositoryName: "other/app" },
      grants: [grant({ tokenId: "t1", userId: null })],
    });
    expect(denied.allowed).toBe(false);
    expect(denied.code).toBe("insufficient_scope");
  });

  test("user permissions are grant based", () => {
    expect(
      can({
        principal: user,
        action: "write",
        resource: { type: "repository", orgId: "orgA", repositoryName: "acme/app" },
        grants: [grant()],
      }).allowed,
    ).toBe(true);
    expect(
      can({
        principal: user,
        action: "delete",
        resource: { type: "repository", orgId: "orgA", repositoryName: "acme/app" },
        grants: [grant()],
      }).allowed,
    ).toBe(false);
  });
});

describe("delegated registry bearer token", () => {
  const reg = (access: { type: string; name: string; actions: string[] }[]): Principal => ({
    kind: "registryToken",
    subject: "ci",
    access,
  });
  const repoRes = (repositoryName: string) => ({ type: "repository", repositoryName }) as const;

  test("allows the granted generic action on the matching repository", () => {
    const p = reg([{ type: "repository", name: "acme/app", actions: ["read"] }]);
    expect(can({ principal: p, action: "read", resource: repoRes("acme/app") }).allowed).toBe(true);
  });

  test("denies an action not present in the claim", () => {
    const p = reg([{ type: "repository", name: "acme/app", actions: ["read"] }]);
    const decision = can({ principal: p, action: "write", resource: repoRes("acme/app") });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("insufficient_scope");
  });

  test("a wildcard claim grants any action", () => {
    const p = reg([{ type: "repository", name: "acme/app", actions: ["*"] }]);
    expect(can({ principal: p, action: "write", resource: repoRes("acme/app") }).allowed).toBe(
      true,
    );
    expect(can({ principal: p, action: "delete", resource: repoRes("acme/app") }).allowed).toBe(
      true,
    );
  });

  test("denies on repository-name mismatch and on empty access", () => {
    const p = reg([{ type: "repository", name: "acme/app", actions: ["read"] }]);
    expect(can({ principal: p, action: "read", resource: repoRes("acme/other") }).allowed).toBe(
      false,
    );
    expect(can({ principal: reg([]), action: "read", resource: repoRes("acme/app") }).allowed).toBe(
      false,
    );
  });
});
