import { describe, expect, test } from "bun:test";
import { RegistryError } from "@hootifactory/registry";
import {
  allNugetSearchResultsRequest,
  mergeNugetSearchBodies,
  nugetSearchWindow,
  parseNugetSearchBody,
} from "./nuget-adapter";

describe("NuGet virtual search helpers", () => {
  test("parses search windows with defaults", () => {
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
    expect(() => nugetSearchWindow(new Request("https://registry.test/query?skip=-1"))).toThrow(
      RegistryError,
    );
  });

  test("builds all-results member requests while preserving headers", () => {
    const request = allNugetSearchResultsRequest(
      new Request("https://registry.test/query?skip=20&take=10&q=foo", {
        headers: { "x-request-id": "req-1" },
      }),
    );

    expect(request.headers.get("x-request-id")).toBe("req-1");
    expect(new URL(request.url).searchParams.get("skip")).toBe("0");
    expect(new URL(request.url).searchParams.get("take")).toBe("100");
    expect(new URL(request.url).searchParams.get("q")).toBe("foo");
  });

  test("rewrites and merges search bodies case-insensitively", () => {
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

  test("validates search bodies from members", () => {
    expect(parseNugetSearchBody("{", "hosted", "virtual")).toBeNull();
    expect(parseNugetSearchBody(JSON.stringify({ data: null }), "hosted", "virtual")).toBeNull();
    expect(
      parseNugetSearchBody(JSON.stringify({ totalHits: "1", data: [] }), "hosted", "virtual"),
    ).toBeNull();
  });

  test("keeps search bodies unchanged when mount paths match", () => {
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
