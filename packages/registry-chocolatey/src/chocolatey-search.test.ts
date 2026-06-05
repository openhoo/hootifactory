import { describe, expect, test } from "bun:test";
import { parseChocolateySearchQuery } from "./chocolatey-search";

const base = "https://registry.test/chocolatey/private/api/v2/Search()";

describe("Chocolatey search query parsing", () => {
  test("unquotes the searchTerm and lowercases it", () => {
    const q = parseChocolateySearchQuery(`${base}?searchTerm='Git'`);
    expect(q.term).toBe("git");
    expect(q.includePrerelease).toBe(false);
  });

  test("reads includePrerelease and paging bounds", () => {
    const q = parseChocolateySearchQuery(
      `${base}?searchTerm='git'&includePrerelease=true&$skip=5&$top=10`,
    );
    expect(q).toEqual({ term: "git", includePrerelease: true, skip: 5, top: 10 });
  });

  test("clamps $top to the maximum and defaults when omitted", () => {
    expect(parseChocolateySearchQuery(`${base}?$top=9999`).top).toBe(100);
    expect(parseChocolateySearchQuery(`${base}`).top).toBe(30);
  });

  test("rejects non-integer paging values", () => {
    expect(() => parseChocolateySearchQuery(`${base}?$skip=abc`)).toThrow();
    expect(() => parseChocolateySearchQuery(`${base}?$top=-1`)).toThrow();
  });
});
