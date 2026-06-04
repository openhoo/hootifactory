import { describe, expect, test } from "bun:test";
import { buildOciTagsListResponse, parseOciTagsListQuery } from "./oci-tags";

async function readTagsResponse(response: Response): Promise<{
  body: { name: string; tags: string[] };
  link: string | null;
}> {
  return {
    body: (await response.json()) as { name: string; tags: string[] },
    link: response.headers.get("link"),
  };
}

function responseFor(url: string, tags: string[], truncated = false): Response {
  return buildOciTagsListResponse({
    baseUrl: "https://registry.test",
    mountPath: "v2/acme/containers",
    image: "team/api",
    name: "acme/containers/team/api",
    tags,
    truncated,
    query: parseOciTagsListQuery(url),
  });
}

describe("OCI tags list response", () => {
  test("returns the provided tag page without reordering", async () => {
    const result = await readTagsResponse(
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list", [
        "v2",
        "latest",
        "v1",
      ]),
    );

    expect(result).toEqual({
      body: { name: "acme/containers/team/api", tags: ["v2", "latest", "v1"] },
      link: null,
    });
  });

  test("emits a next link for truncated cursor pages", async () => {
    const result = await readTagsResponse(
      responseFor(
        "https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=latest",
        ["v1"],
        true,
      ),
    );

    expect(result).toEqual({
      body: { name: "acme/containers/team/api", tags: ["v1"] },
      link: '<https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=v1>; rel="next"',
    });
  });

  test("normalizes the page size before serializing next links", async () => {
    const result = await readTagsResponse(
      responseFor(
        "https://registry.test/v2/acme/containers/team/api/tags/list?n=1%0D%0A&last=latest",
        ["v1"],
        true,
      ),
    );

    expect(result).toEqual({
      body: { name: "acme/containers/team/api", tags: ["v1"] },
      link: '<https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=v1>; rel="next"',
    });
  });

  test("supports zero-length pages without emitting an unusable next link", async () => {
    const result = await readTagsResponse(
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list?n=0", [], true),
    );

    expect(result).toEqual({
      body: { name: "acme/containers/team/api", tags: [] },
      link: null,
    });
  });

  test("validates cursor and page size query parameters", () => {
    expect(() =>
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list?last=bad/tag", []),
    ).toThrow();
    expect(() =>
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list?n=-1", []),
    ).toThrow();
  });
});
