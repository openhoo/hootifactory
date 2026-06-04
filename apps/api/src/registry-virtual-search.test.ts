import { describe, expect, test } from "bun:test";
import { RegistryError } from "@hootifactory/registry";
import {
  allNpmSearchResultsRequest,
  allNugetSearchResultsRequest,
  mergeNpmSearchBodies,
  mergeNugetSearchBodies,
  npmSearchWindow,
  nugetSearchWindow,
  parseNpmSearchBody,
  parseNugetSearchBody,
} from "./registry-virtual-search";

describe("virtual registry search helpers", () => {
  test("parses npm and NuGet search windows with defaults", () => {
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
    expect(nugetSearchWindow(new Request("https://registry.test/query?q=foo"))).toEqual({
      skip: 0,
      take: 20,
    });
    expect(nugetSearchWindow(new Request("https://registry.test/query?skip=4&take=7"))).toEqual({
      skip: 4,
      take: 7,
    });
  });

  test("normalizes invalid search windows into registry errors", () => {
    expect(() =>
      npmSearchWindow(new Request("https://registry.test/-/v1/search?size=101")),
    ).toThrow(RegistryError);
    expect(() => nugetSearchWindow(new Request("https://registry.test/query?skip=-1"))).toThrow(
      RegistryError,
    );
  });

  test("builds all-results member requests while preserving method and headers", () => {
    const npm = allNpmSearchResultsRequest(
      new Request("https://registry.test/-/v1/search?from=40&size=10&text=foo", {
        method: "HEAD",
        headers: { authorization: "Bearer token" },
      }),
    );
    const nuget = allNugetSearchResultsRequest(
      new Request("https://registry.test/query?skip=20&take=10&q=foo", {
        headers: { "x-request-id": "req-1" },
      }),
    );

    expect(npm.method).toBe("HEAD");
    expect(npm.headers.get("authorization")).toBe("Bearer token");
    expect(new URL(npm.url).searchParams.get("from")).toBe("0");
    expect(new URL(npm.url).searchParams.get("size")).toBe("250");
    expect(new URL(npm.url).searchParams.get("text")).toBe("foo");
    expect(nuget.headers.get("x-request-id")).toBe("req-1");
    expect(new URL(nuget.url).searchParams.get("skip")).toBe("0");
    expect(new URL(nuget.url).searchParams.get("take")).toBe("100");
    expect(new URL(nuget.url).searchParams.get("q")).toBe("foo");
  });

  test("merges npm search bodies by first package name and slices results", () => {
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

  test("validates npm search bodies from members", () => {
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

  test("rewrites and merges NuGet search bodies case-insensitively", () => {
    const parsedBody = parseNugetSearchBody(
      JSON.stringify({
        totalHits: 2,
        data: [
          { id: "Package.One", registration: "/hosted/registration/package.one/index.json" },
          { id: "package.two", registration: "/hosted/registration/package.two/index.json" },
        ],
      }),
      "hosted",
      "virtual",
    );
    expect(parsedBody).not.toBeNull();
    const body = parsedBody!;

    expect(body.data?.[0]?.registration).toBe("/virtual/registration/package.one/index.json");
    expect(
      mergeNugetSearchBodies(
        [
          body,
          {
            data: [
              { id: "package.one", registration: "/other/registration/package.one/index.json" },
              { id: "package.three" },
              { id: 123 },
            ],
          },
        ],
        { skip: 1, take: 2 },
      ),
    ).toEqual({
      totalHits: 3,
      data: [
        { id: "package.two", registration: "/virtual/registration/package.two/index.json" },
        { id: "package.three" },
      ],
    });
  });

  test("validates NuGet search bodies from members", () => {
    expect(parseNugetSearchBody("{", "hosted", "virtual")).toBeNull();
    expect(parseNugetSearchBody(JSON.stringify({ data: null }), "hosted", "virtual")).toBeNull();
    expect(
      parseNugetSearchBody(JSON.stringify({ totalHits: "1", data: [] }), "hosted", "virtual"),
    ).toBeNull();
  });

  test("keeps NuGet search bodies unchanged when mount paths match", () => {
    expect(
      parseNugetSearchBody(
        JSON.stringify({
          data: [
            { id: "package.one", registration: "/virtual/registration/package.one/index.json" },
          ],
        }),
        "virtual",
        "virtual",
      )?.data?.[0]?.registration,
    ).toBe("/virtual/registration/package.one/index.json");
  });
});
