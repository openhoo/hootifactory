import { describe, expect, test } from "bun:test";
import type { TokenScope } from "@hootifactory/db";
import { patternMatches, scopeGrants, scopeSpecificity } from "./scope";

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
});
