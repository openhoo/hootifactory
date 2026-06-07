import { describe, expect, test } from "bun:test";
import type { RouteEntry } from "../plugin/adapter";
import { compileRoute, compileRoutes, matchRoute } from "./route-matcher";

const routes: RouteEntry[] = [
  { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  { method: "GET", pattern: "/health/", handlerId: "health" },
  { method: "GET", pattern: "/literal.path", handlerId: "literal" },
];
const compiled = compileRoutes(routes);

describe("route matcher — safeDecode fallback", () => {
  test("malformed percent-encoding is left verbatim instead of throwing", () => {
    // `%zz` is not valid percent-encoding; decodeURIComponent throws, so the
    // matcher must fall back to the raw segment value.
    const m = matchRoute(compiled, "GET", "/lib%zz/manifests/latest");
    expect(m?.entry.handlerId).toBe("getManifest");
    expect(m?.params.name).toBe("lib%zz");
    expect(m?.params.reference).toBe("latest");
  });
});

describe("route matcher — compileRoute structure", () => {
  test("greedy and single-segment params are flagged correctly", () => {
    const compiledRoute = compileRoute(routes[0]!);
    expect(compiledRoute.params).toEqual([
      { name: "name", greedy: true },
      { name: "reference", greedy: false },
    ]);
    expect(compiledRoute.regex.test("/a/b/manifests/latest")).toBe(true);
  });

  test("a literal pattern with regex metacharacters is escaped", () => {
    // The `.` in "literal.path" must match a literal dot, not any character.
    expect(matchRoute(compiled, "GET", "/literal.path")?.entry.handlerId).toBe("literal");
    expect(matchRoute(compiled, "GET", "/literalXpath")).toBeNull();
  });

  test("a trailing slash in the pattern is optional", () => {
    expect(matchRoute(compiled, "GET", "/health")?.entry.handlerId).toBe("health");
    expect(matchRoute(compiled, "GET", "/health/")?.entry.handlerId).toBe("health");
  });

  test("no route matches an unrelated path", () => {
    expect(matchRoute(compiled, "GET", "/nope")).toBeNull();
  });
});
