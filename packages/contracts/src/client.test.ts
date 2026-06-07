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

  test("issues each endpoint against its method, path, headers, and body", async () => {
    const calls: Array<{
      path: string;
      method?: string;
      headers: Record<string, string>;
      body?: unknown;
    }> = [];
    const client = createHootifactoryClient(async (path, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({
        path,
        method: init?.method,
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      return Response.json({ ok: true });
    });

    await client.me();
    await client.authMethods();
    await client.login("alice", "pw");
    await client.register("alice", "a@test", "pw");
    await client.requestPasswordReset("a@test");
    await client.confirmPasswordReset("tok", "newpw");
    await client.logout();
    await client.orgs();
    await client.createOrg("acme", "Acme");
    await client.repos("org-1");
    await client.registryModules();
    await client.createRepo("org-1", { name: "lib" });
    await client.repo("repo-1");
    await client.tokens("org-1");
    await client.createToken("org-1", { name: "ci" });
    await client.revokeToken("org-1", "tok-1");

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/me",
      "GET /api/auth/methods",
      "POST /api/auth/login",
      "POST /api/auth/register",
      "POST /api/auth/password-reset/request",
      "POST /api/auth/password-reset/confirm",
      "POST /api/auth/logout",
      "GET /api/orgs",
      "POST /api/orgs",
      "GET /api/orgs/org-1/repositories",
      "GET /api/registry-modules",
      "POST /api/orgs/org-1/repositories",
      "GET /api/repositories/repo-1",
      "GET /api/orgs/org-1/tokens",
      "POST /api/orgs/org-1/tokens",
      "DELETE /api/orgs/org-1/tokens/tok-1",
    ]);

    const login = calls.find((c) => c.path === "/api/auth/login");
    expect(login?.headers["content-type"]).toBe("application/json");
    expect(login?.body).toEqual({ username: "alice", password: "pw" });

    const logout = calls.find((c) => c.path === "/api/auth/logout");
    expect(logout?.headers["content-type"]).toBeUndefined();
    expect(logout?.body).toBeUndefined();
  });

  test("omits the query suffix when no pagination is provided", async () => {
    const paths: string[] = [];
    const client = createHootifactoryClient(async (path) => {
      paths.push(path);
      return Response.json({ data: [], pagination: { limit: 100, offset: 0, total: 0 } });
    });

    await client.packages("repo-1");
    await client.versions("pkg-1");
    await client.assets("repo-1");

    expect(paths).toEqual([
      "/api/repositories/repo-1/packages",
      "/api/packages/pkg-1/versions",
      "/api/v1/repositories/repo-1/assets",
    ]);
  });

  test("defaults to the global fetch when no fetch function is supplied", async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string) => {
      seen.push(String(input));
      return Response.json({ orgs: [] });
    }) as typeof fetch;
    try {
      const client = createHootifactoryClient();
      await expect(client.orgs()).resolves.toEqual({ orgs: [] });
      expect(seen).toEqual(["/api/orgs"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
