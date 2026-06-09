import { describe, expect, test } from "bun:test";
import { grantGrants, patternMatches, scopeMayTargetRepo, scopeSpecificity } from "./scope";

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

  test("structured grants match resource-specific targets", () => {
    expect(grantGrants([{ permission: "org.read" }], { type: "org", orgId: "org_1" }, "read")).toBe(
      true,
    );
    expect(
      grantGrants(
        [{ permission: "org.read" }],
        { type: "repository", orgId: "org_1", repositoryName: "team/web" },
        "read",
      ),
    ).toBe(false);

    expect(
      grantGrants(
        [{ permission: "package.read", repository: "team/*", package: "@scope/*" }],
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
        [{ permission: "policy.write", policy: "quota", repository: "team/*" }],
        { type: "policy", orgId: "org_1", repositoryName: "team/web", policy: "quota" },
        "write",
      ),
    ).toBe(true);

    expect(
      grantGrants(
        [{ permission: "token.rotate", tokenTarget: "self" }],
        { type: "token", orgId: "org_1", tokenId: "tok_1", tokenTarget: "self" },
        "write",
        "tok_1",
      ),
    ).toBe(true);

    expect(
      grantGrants(
        [{ permission: "artifact.read", repository: "team/*", artifact: "sha256:*" }],
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

  test("matches token scope patterns against mount-relative paths", () => {
    const namedRepo = { name: "packages", mountPath: "mod/acme/packages" };
    expect(scopeMayTargetRepo("packages", namedRepo)).toBe(true);
    expect(scopeMayTargetRepo("pack*", namedRepo)).toBe(true);
    expect(scopeMayTargetRepo("other*", namedRepo)).toBe(false);

    // A module whose clients address it by mount-relative path: the first mount
    // segment is stripped and the remainder is matched.
    const pathAddressedRepo = { name: "containers", mountPath: "mod/acme/containers" };
    expect(scopeMayTargetRepo("acme/containers", pathAddressedRepo)).toBe(true);
    expect(scopeMayTargetRepo("acme/containers/app", pathAddressedRepo)).toBe(true);
    expect(scopeMayTargetRepo("acme/*", pathAddressedRepo)).toBe(true);
    expect(scopeMayTargetRepo("other/*", pathAddressedRepo)).toBe(false);
  });
});
