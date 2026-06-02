import { describe, expect, test } from "bun:test";
import { buildNpmSearchObject, buildNpmSearchResponse, parseNpmSearchQuery } from "./npm-search";

describe("npm search helpers", () => {
  test("parses search query defaults and pagination values", () => {
    expect(parseNpmSearchQuery("https://registry.test/-/v1/search")).toEqual({
      text: "",
      from: 0,
      size: 20,
    });
    expect(
      parseNpmSearchQuery("https://registry.test/-/v1/search?text=hoot&from=3&size=10"),
    ).toEqual({
      text: "hoot",
      from: 3,
      size: 10,
    });
  });

  test("rejects invalid search query values before database work", () => {
    expect(() => parseNpmSearchQuery("https://registry.test/-/v1/search?from=-1")).toThrow();
    expect(() =>
      parseNpmSearchQuery(`https://registry.test/-/v1/search?text=${"x".repeat(257)}`),
    ).toThrow();
  });

  test("builds npm-compatible search objects from stored version metadata", () => {
    const object = buildNpmSearchObject({
      packageName: "@scope/hoot",
      selected: {
        version: "1.2.3",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        metadata: {
          manifest: {
            description: "registry helper",
            keywords: ["registry", "hoot"],
          },
        },
      },
      baseUrl: "https://registry.test",
      mountPath: "npm/private",
    });

    expect(object).toEqual({
      package: {
        name: "@scope/hoot",
        version: "1.2.3",
        description: "registry helper",
        keywords: ["registry", "hoot"],
        date: "2026-01-02T03:04:05.000Z",
        links: { npm: "https://registry.test/npm/private/%40scope%2Fhoot" },
        publisher: { username: "hootifactory", email: "" },
        maintainers: [{ username: "hootifactory", email: "" }],
      },
      score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
      searchScore: 1,
    });
  });

  test("wraps search objects with total and response time", () => {
    expect(
      buildNpmSearchResponse({ objects: [], total: 3, time: "2026-01-02T03:04:05.000Z" }),
    ).toEqual({
      objects: [],
      total: 3,
      time: "2026-01-02T03:04:05.000Z",
    });
  });
});
