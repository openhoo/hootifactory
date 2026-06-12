import { describe, expect, test } from "bun:test";
import { patternMatches, scopeMayTargetRepo } from "./scope";

describe("token scope helpers", () => {
  test("matches exact, prefix, slash-prefix, and org-wide patterns", () => {
    expect(patternMatches("*", "any/repo")).toBe(true);
    expect(patternMatches("team/*", "team")).toBe(true);
    expect(patternMatches("team/*", "team/api")).toBe(true);
    expect(patternMatches("team*", "team-api")).toBe(true);
    expect(patternMatches("team/api", "team/api")).toBe(true);
    expect(patternMatches("team/api", "team/api2")).toBe(false);
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
