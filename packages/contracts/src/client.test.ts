import { describe, expect, test } from "bun:test";
import { ApiError, createHootifactoryClient } from "./client";

describe("Hootifactory API client", () => {
  test("uses validated JSON error messages", async () => {
    const client = createHootifactoryClient(async () =>
      Response.json({ error: "invalid request", extra: true }, { status: 400 }),
    );

    await expect(client.orgs()).rejects.toMatchObject({
      status: 400,
      message: "invalid request",
      data: { error: "invalid request", extra: true },
    });
  });

  test("falls back to status text for malformed error bodies", async () => {
    const textClient = createHootifactoryClient(
      async () => new Response("not json", { status: 502, statusText: "Bad Gateway" }),
    );
    const malformedJsonClient = createHootifactoryClient(async () =>
      Response.json({ error: 123 }, { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(textClient.orgs()).rejects.toMatchObject({
      status: 502,
      message: "Bad Gateway",
      data: "not json",
    });
    await expect(malformedJsonClient.orgs()).rejects.toBeInstanceOf(ApiError);
    await expect(malformedJsonClient.orgs()).rejects.toMatchObject({
      status: 500,
      message: "Internal Server Error",
    });
  });

  test("uses API v1 nested error messages", async () => {
    const client = createHootifactoryClient(async () =>
      Response.json(
        { error: { code: "BAD_REQUEST", message: "invalid token request", issues: {} } },
        { status: 400 },
      ),
    );

    await expect(client.assets("repo-1")).rejects.toMatchObject({
      status: 400,
      message: "invalid token request",
      data: { error: { code: "BAD_REQUEST", message: "invalid token request", issues: {} } },
    });
  });

  test("falls back for malformed API v1 error bodies", async () => {
    const client = createHootifactoryClient(async () =>
      Response.json(
        { error: { code: "BAD_REQUEST", message: "" } },
        { status: 400, statusText: "Bad Request" },
      ),
    );

    await expect(client.assets("repo-1")).rejects.toMatchObject({
      status: 400,
      message: "Bad Request",
    });
  });

  test("uses expected paths for paginated inventory and API v1 contracts", async () => {
    const requests: Array<{ path: string; method?: string }> = [];
    const client = createHootifactoryClient(async (path, init) => {
      requests.push({ path, method: init?.method });
      return Response.json({ data: [], pagination: { limit: 25, offset: 5, total: 0 } });
    });

    await client.packages("repo-1", { limit: 50, offset: 100 });
    await client.versions("pkg-1", { limit: 25, offset: 5 });
    await client.version("pkg-1", "1.0.0+build");
    await client.assets("repo-1", {
      limit: 25,
      offset: 5,
      packageId: "pkg-1",
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(requests).toEqual([
      { method: "GET", path: "/api/repositories/repo-1/packages?limit=50&offset=100" },
      { method: "GET", path: "/api/packages/pkg-1/versions?limit=25&offset=5" },
      { method: "GET", path: "/api/v1/packages/pkg-1/versions/1.0.0%2Bbuild" },
      {
        method: "GET",
        path: "/api/v1/repositories/repo-1/assets?limit=25&offset=5&packageId=pkg-1&digest=sha256%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
  });

  test("treats empty successful responses as no data", async () => {
    const client = createHootifactoryClient(async () => new Response(null, { status: 204 }));

    await expect(client.logout()).resolves.toBeUndefined();
  });
});
