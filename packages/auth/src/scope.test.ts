import { describe, expect, test } from "bun:test";
import type { TokenScope } from "@hootifactory/types";
import {
  grantGrants,
  patternMatches,
  scopeGrants,
  scopeMayTargetRepo,
  scopeSpecificity,
} from "./scope";

describe("token scope helpers", () => {
  test("matches exact, prefix, slash-prefix, and org-wide patterns", () => {
    expect(patternMatches("*", "any/repo")).toBe(true);
    expect(patternMatches("team/*", "team")).toBe(true);
    expect(patternMatches("team/*", "team/api")).toBe(true);
    expect(patternMatches("team*", "team-api")).toBe(true);
    expect(patternMatches("team/api", "team/api")).toBe(true);
    expect(patternMatches("team/api", "team/api2")).toBe(false);
  });

  test("orders exact patterns above globs and org-wide scopes", () => {
    expect(scopeSpecificity("*")).toBeLessThan(scopeSpecificity("team/*"));
    expect(scopeSpecificity("team/*")).toBeLessThan(scopeSpecificity("team/api"));
  });

  test("grants only matching actions for matching repositories", () => {
    const scopes = [
      { repository: "team/*", actions: ["read"] },
      { repository: "team/api", actions: ["write"] },
    ] satisfies TokenScope[];

    expect(scopeGrants(scopes, "team/web", "read")).toBe(true);
    expect(scopeGrants(scopes, "team/web", "write")).toBe(false);
    expect(scopeGrants(scopes, "team/api", "write")).toBe(true);
  });

  test("structured grants match resource-specific targets", () => {
    expect(
      grantGrants(
        [{ resource: "org", actions: ["read"] }],
        { type: "org", orgId: "org_1" },
        "read",
      ),
    ).toBe(true);
    expect(
      grantGrants(
        [{ resource: "org", actions: ["read"] }],
        { type: "repository", orgId: "org_1", repositoryName: "team/web" },
        "read",
      ),
    ).toBe(false);

    expect(
      grantGrants(
        [{ resource: "package", repository: "team/*", package: "@scope/*", actions: ["read"] }],
        {
          type: "package",
          orgId: "org_1",
          repositoryName: "team/web",
          packageName: "@scope/pkg",
        },
        "read",
      ),
    ).toBe(true);

    expect(
      grantGrants(
        [{ resource: "policy", policy: "quota", repository: "team/*", actions: ["write"] }],
        { type: "policy", orgId: "org_1", repositoryName: "team/web", policy: "quota" },
        "write",
      ),
    ).toBe(true);

    expect(
      grantGrants(
        [{ resource: "token", target: "self", actions: ["write"] }],
        { type: "token", orgId: "org_1", tokenId: "tok_1", tokenTarget: "self" },
        "write",
        "tok_1",
      ),
    ).toBe(true);

    expect(
      grantGrants(
        [{ resource: "artifact", repository: "team/*", artifact: "sha256:*", actions: ["read"] }],
        {
          type: "artifact",
          orgId: "org_1",
          repositoryName: "other/web",
          artifactRef: "sha256:abc",
        },
        "read",
      ),
    ).toBe(false);
  });

  test("matches token scope patterns against OCI mount prefixes", () => {
    const npmRepo = { name: "packages", mountPath: "npm/acme/packages" };
    expect(scopeMayTargetRepo("packages", npmRepo)).toBe(true);
    expect(scopeMayTargetRepo("pack*", npmRepo)).toBe(true);
    expect(scopeMayTargetRepo("other*", npmRepo)).toBe(false);

    const dockerRepo = { name: "containers", mountPath: "v2/acme/containers" };
    expect(scopeMayTargetRepo("acme/containers", dockerRepo)).toBe(true);
    expect(scopeMayTargetRepo("acme/containers/app", dockerRepo)).toBe(true);
    expect(scopeMayTargetRepo("acme/*", dockerRepo)).toBe(true);
    expect(scopeMayTargetRepo("other/*", dockerRepo)).toBe(false);
  });
});
