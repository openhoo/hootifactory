import { describe, expect, test } from "bun:test";
import { RegistryError } from "@hootifactory/registry";
import {
  allNpmSearchResultsRequest,
  mergeNpmSearchBodies,
  npmSearchWindow,
  parseNpmSearchBody,
} from "./npm-virtual-search";

describe("npm virtual search helpers", () => {
  test("parses search windows with defaults", () => {
    expect(npmSearchWindow(new Request("https://registry.test/-/v1/search?text=foo"))).toEqual({
      from: 0,
      size: 20,
    });
    expect(npmSearchWindow(new Request("https://registry.test/-/v1/search?from=2&size=5"))).toEqual(
      {
        from: 2,
        size: 5,
      },
    );
  });

  test("normalizes invalid search windows into registry errors", () => {
    expect(() =>
      npmSearchWindow(new Request("https://registry.test/-/v1/search?size=101")),
    ).toThrow(RegistryError);
  });

  test("builds all-results member requests while preserving method and headers", () => {
    const request = allNpmSearchResultsRequest(
      new Request("https://registry.test/-/v1/search?from=40&size=10&text=foo", {
        method: "HEAD",
        headers: { authorization: "Bearer token" },
      }),
    );

    expect(request.method).toBe("HEAD");
    expect(request.headers.get("authorization")).toBe("Bearer token");
    expect(new URL(request.url).searchParams.get("from")).toBe("0");
    expect(new URL(request.url).searchParams.get("size")).toBe("250");
    expect(new URL(request.url).searchParams.get("text")).toBe("foo");
  });

  test("merges search bodies by first package name and slices results", () => {
    expect(
      mergeNpmSearchBodies(
        [
          {
            total: 3,
            objects: [
              { package: { name: "alpha" } },
              { package: { name: "beta" } },
              { package: { name: "alpha" } },
            ],
          },
          {
            objects: [
              { package: { name: "gamma" } },
              { package: { name: 123 } },
              { package: { name: "beta" } },
            ],
          },
        ],
        { from: 1, size: 2 },
      ),
    ).toEqual({
      objects: [{ package: { name: "beta" } }, { package: { name: "gamma" } }],
      total: 3,
    });
  });

  test("validates search bodies from members", () => {
    expect(
      parseNpmSearchBody({
        total: 1,
        objects: [{ package: { name: "alpha" }, score: 1 }],
      }),
    ).toEqual({
      total: 1,
      objects: [{ package: { name: "alpha" }, score: 1 }],
    });
    expect(parseNpmSearchBody({ objects: null })).toBeNull();
    expect(parseNpmSearchBody({ total: "1", objects: [] })).toBeNull();
  });
});
