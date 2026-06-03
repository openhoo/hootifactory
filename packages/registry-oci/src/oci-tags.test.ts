import { describe, expect, test } from "bun:test";
import { buildOciTagsListResponse } from "./oci-tags";

async function readTagsResponse(response: Response): Promise<{
  body: { name: string; tags: string[] };
  link: string | null;
}> {
  return {
    body: (await response.json()) as { name: string; tags: string[] },
    link: response.headers.get("link"),
  };
}

function responseFor(url: string, tags: string[]): Response {
  return buildOciTagsListResponse({
    baseUrl: "https://registry.test",
    mountPath: "v2/acme/containers",
    image: "team/api",
    name: "acme/containers/team/api",
    tags,
    url,
  });
}

describe("OCI tags list response", () => {
  test("returns sorted tags when no cursor or page size is requested", async () => {
    const result = await readTagsResponse(
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list", [
        "v2",
        "latest",
        "v1",
      ]),
    );

    expect(result).toEqual({
      body: { name: "acme/containers/team/api", tags: ["latest", "v1", "v2"] },
      link: null,
    });
  });

  test("applies the last cursor and emits a next link for truncated pages", async () => {
    const result = await readTagsResponse(
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=latest", [
        "latest",
        "v1",
        "v2",
      ]),
    );

    expect(result).toEqual({
      body: { name: "acme/containers/team/api", tags: ["v1"] },
      link: '<https://registry.test/v2/acme/containers/team/api/tags/list?n=1&last=v1>; rel="next"',
    });
  });

  test("supports zero-length pages without emitting an unusable next link", async () => {
    const result = await readTagsResponse(
      responseFor("https://registry.test/v2/acme/containers/team/api/tags/list?n=0", [
        "latest",
        "v1",
      ]),
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
