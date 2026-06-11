import { describe, expect, test } from "bun:test";
import type { V1ApiToken, V1Repository, V1TokenGrant } from "./api-v1";
import {
  ApiContractViolationError,
  ApiError,
  apiErrorMessage,
  createHootifactoryClient,
} from "./client";

const UUID = "00000000-0000-4000-8000-000000000001";
const UUID2 = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-01-01T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const repository: V1Repository = {
  id: UUID,
  orgId: UUID2,
  name: "lib",
  moduleId: "mod",
  kind: "hosted",
  visibility: "private",
  mountPath: "mod/acme/lib",
  description: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const token: V1ApiToken = {
  id: UUID,
  ownerUserId: UUID2,
  ownerUsername: "alice",
  name: "ci",
  prefix: "hoot_x",
  type: "personal",
  grants: [{ permission: "repository.read", repository: "*" }],
  expiresAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revokedByTokenId: null,
  revocationReason: null,
  rotatedAt: null,
  rotatedByUserId: null,
  rotatedByTokenId: null,
  lastUsedAt: null,
  createdAt: NOW,
};

const user = {
  id: UUID,
  username: "alice",
  email: "alice@example.test",
  displayName: null,
  isSystem: false,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const group = {
  id: UUID,
  orgId: UUID2,
  slug: "devs",
  displayName: "Devs",
  description: null,
  managedBy: null,
  externalKey: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const asset = {
  id: UUID,
  orgId: UUID2,
  repositoryId: UUID,
  packageId: null,
  packageVersionId: null,
  blobRefId: null,
  digest: DIGEST,
  role: "tarball",
  scope: "lib@1.0.0",
  path: null,
  mediaType: null,
  sizeBytes: 5,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const pagination = { limit: 100, offset: 0, total: 1 };

function clientReturning(bodies: Record<string, unknown>, calls?: string[]) {
  return createHootifactoryClient(async (path, init) => {
    const method = init?.method ?? "GET";
    calls?.push(`${method} ${path}`);
    const key = `${method} ${path.split("?")[0]}`;
    if (!(key in bodies)) throw new Error(`unexpected request: ${key}`);
    return Response.json(bodies[key]);
  });
}

describe("Hootifactory API client errors", () => {
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

  test("uses flat auth-route error messages", async () => {
    const client = createHootifactoryClient(async () =>
      Response.json({ error: "invalid credentials" }, { status: 401 }),
    );

    await expect(client.login("alice", "wrong")).rejects.toMatchObject({
      status: 401,
      message: "invalid credentials",
    });
  });

  test("falls back to status text for malformed error bodies", async () => {
    const textClient = createHootifactoryClient(
      async () => new Response("not json", { status: 502, statusText: "Bad Gateway" }),
    );
    const malformedJsonClient = createHootifactoryClient(async () =>
      Response.json({ error: 123 }, { status: 500, statusText: "Internal Server Error" }),
    );
    const emptyV1MessageClient = createHootifactoryClient(async () =>
      Response.json(
        { error: { code: "BAD_REQUEST", message: "" } },
        { status: 400, statusText: "Bad Request" },
      ),
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
    await expect(emptyV1MessageClient.assets("repo-1")).rejects.toMatchObject({
      status: 400,
      message: "Bad Request",
    });
  });

  test("apiErrorMessage unwraps ApiError and falls back otherwise", () => {
    const error = new ApiError(404, "missing", { detail: true });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.data).toEqual({ detail: true });
    expect(apiErrorMessage(error)).toBe("missing");
    expect(apiErrorMessage("plain string")).toBe("failed");
    expect(apiErrorMessage("plain string", "custom")).toBe("custom");
  });
});

describe("Hootifactory API client contract validation", () => {
  test("rejects successful responses that violate the contract", async () => {
    const client = createHootifactoryClient(async () => Response.json({ orgs: [] }));

    const failure = client.orgs();
    await expect(failure).rejects.toBeInstanceOf(ApiContractViolationError);
    await expect(failure).rejects.toThrow(/GET \/api\/v1\/orgs/);
  });

  test("rejects list payloads with malformed items", async () => {
    const client = createHootifactoryClient(async () =>
      Response.json({ data: [{ id: "not-a-uuid" }], pagination }),
    );

    await expect(client.users()).rejects.toBeInstanceOf(ApiContractViolationError);
  });
});

describe("Hootifactory API client endpoints", () => {
  test("me unwraps the data envelope", async () => {
    const principal = { kind: "user", userId: UUID, username: "alice" };
    const client = clientReturning({
      "GET /api/v1/me": { data: { authenticated: true, principal } },
    });
    await expect(client.me()).resolves.toEqual({
      authenticated: true,
      principal: { kind: "user", userId: UUID, username: "alice" },
    });
  });

  test("session auth endpoints hit /api/auth and validate bodies", async () => {
    const calls: string[] = [];
    const client = clientReturning(
      {
        "GET /api/auth/methods": {
          password: true,
          registration: true,
          oidc: { enabled: false },
        },
        "POST /api/auth/login": { user: { id: UUID, username: "alice" } },
        "POST /api/auth/register": {
          user: { id: UUID, username: "alice", email: "a@test" },
        },
        "POST /api/auth/password-reset/request": { ok: true },
        "POST /api/auth/password-reset/confirm": { ok: true },
        "POST /api/auth/logout": { ok: true },
      },
      calls,
    );

    await expect(client.authMethods()).resolves.toMatchObject({ password: true });
    await expect(client.login("alice", "pw")).resolves.toEqual({
      user: { id: UUID, username: "alice" },
    });
    await client.register("alice", "a@test", "pw");
    await expect(client.requestPasswordReset("a@test")).resolves.toEqual({ ok: true });
    await expect(client.confirmPasswordReset("tok", "pw2")).resolves.toEqual({ ok: true });
    await expect(client.logout()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      "GET /api/auth/methods",
      "POST /api/auth/login",
      "POST /api/auth/register",
      "POST /api/auth/password-reset/request",
      "POST /api/auth/password-reset/confirm",
      "POST /api/auth/logout",
    ]);
  });

  test("orgs defaults missing caller permissions to an empty list", async () => {
    const client = clientReturning({
      "GET /api/v1/orgs": {
        data: [
          { id: UUID, slug: "acme", displayName: "Acme", permissions: ["org.read"] },
          { id: UUID2, slug: "io", displayName: "IO" },
        ],
      },
    });
    const { orgs } = await client.orgs();
    expect(orgs.map((org) => org.permissions)).toEqual([["org.read"], []]);
  });

  test("organization and repository endpoints unwrap v1 envelopes", async () => {
    const calls: string[] = [];
    const client = clientReturning(
      {
        "POST /api/v1/orgs": { data: { id: UUID, slug: "acme", displayName: "Acme" } },
        "GET /api/v1/orgs/org-1/repositories": { data: [repository], pagination },
        "POST /api/v1/orgs/org-1/repositories": { data: repository },
        "GET /api/v1/repositories/repo-1": { data: { repository, packageCount: 3 } },
        "GET /api/v1/registry-modules": {
          data: {
            modules: [
              {
                id: "mod",
                displayName: "Module",
                mountSegment: "mod",
                capabilities: {
                  contentAddressable: false,
                  resumableUploads: false,
                  proxyable: true,
                  virtualizable: true,
                },
              },
            ],
          },
        },
      },
      calls,
    );

    await expect(client.createOrg("acme", "Acme")).resolves.toEqual({
      org: { id: UUID, slug: "acme", displayName: "Acme" },
    });
    await expect(client.repos("org-1")).resolves.toEqual({
      repositories: [repository],
      pagination,
    });
    await expect(client.createRepo("org-1", { name: "lib" })).resolves.toEqual({
      repository,
    });
    await expect(client.repo("repo-1")).resolves.toEqual({ repository, packageCount: 3 });
    const { modules } = await client.registryModules();
    expect(modules[0]?.capabilities.proxyable).toBe(true);
    expect(calls).toEqual([
      "POST /api/v1/orgs",
      "GET /api/v1/orgs/org-1/repositories",
      "POST /api/v1/orgs/org-1/repositories",
      "GET /api/v1/repositories/repo-1",
      "GET /api/v1/registry-modules",
    ]);
  });

  test("inventory endpoints unwrap list envelopes and encode queries", async () => {
    const calls: string[] = [];
    const client = clientReturning(
      {
        "GET /api/v1/repositories/repo-1/packages": {
          data: [{ id: UUID, name: "lib", latestVersion: "1.0.0" }],
          pagination,
        },
        "GET /api/v1/packages/pkg-1/versions": {
          data: {
            package: { id: UUID, name: "lib" },
            versions: [{ version: "1.0.0", sizeBytes: 5, createdAt: NOW }],
          },
          pagination,
        },
        "GET /api/v1/packages/pkg-1/versions/1.0.0%2Bbuild": {
          data: {
            package: { id: UUID, name: "lib" },
            version: {
              id: UUID2,
              version: "1.0.0+build",
              metadata: {},
              sizeBytes: 5,
              createdAt: NOW,
            },
            assets: [asset],
          },
        },
        "GET /api/v1/repositories/repo-1/artifacts": {
          data: [
            {
              id: UUID,
              digest: DIGEST,
              name: "lib",
              version: "1.0.0",
              state: "pending",
              policyDecision: null,
              createdAt: NOW,
            },
          ],
          pagination,
        },
        "GET /api/v1/repositories/repo-1/assets": { data: [asset], pagination },
      },
      calls,
    );

    await expect(client.packages("repo-1", { limit: 50, offset: 100 })).resolves.toEqual({
      packages: [{ id: UUID, name: "lib", latestVersion: "1.0.0" }],
      pagination,
    });
    const versions = await client.versions("pkg-1", { limit: 25, offset: 5 });
    expect(versions.package.name).toBe("lib");
    expect(versions.versions).toHaveLength(1);
    const detail = await client.version("pkg-1", "1.0.0+build");
    expect(detail.version.version).toBe("1.0.0+build");
    const artifacts = await client.artifacts("repo-1");
    expect(artifacts.artifacts[0]?.state).toBe("pending");
    const assets = await client.assets("repo-1", {
      limit: 25,
      offset: 5,
      packageId: UUID,
      digest: DIGEST,
    });
    expect(assets.assets).toEqual([asset]);

    expect(calls).toEqual([
      "GET /api/v1/repositories/repo-1/packages?limit=50&offset=100",
      "GET /api/v1/packages/pkg-1/versions?limit=25&offset=5",
      "GET /api/v1/packages/pkg-1/versions/1.0.0%2Bbuild",
      "GET /api/v1/repositories/repo-1/artifacts",
      `GET /api/v1/repositories/repo-1/assets?limit=25&offset=5&packageId=${UUID}&digest=${encodeURIComponent(DIGEST)}`,
    ]);
  });

  test("token endpoints unwrap envelopes", async () => {
    const calls: string[] = [];
    const client = clientReturning(
      {
        "GET /api/v1/orgs/org-1/tokens": { data: [token], pagination },
        "POST /api/v1/orgs/org-1/tokens": { data: { token, secret: "hoot_secret" } },
        "DELETE /api/v1/orgs/org-1/tokens/tok-1": { data: { ok: true } },
      },
      calls,
    );

    await expect(client.tokens("org-1")).resolves.toEqual({ tokens: [token], pagination });
    await expect(client.createToken("org-1", { name: "ci" })).resolves.toEqual({
      token,
      secret: "hoot_secret",
    });
    await expect(client.revokeToken("org-1", "tok-1")).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      "GET /api/v1/orgs/org-1/tokens",
      "POST /api/v1/orgs/org-1/tokens",
      "DELETE /api/v1/orgs/org-1/tokens/tok-1",
    ]);
  });

  test("access management endpoints unwrap envelopes", async () => {
    const calls: string[] = [];
    const grant: V1TokenGrant = { permission: "repository.read", repository: "*" };
    const client = clientReturning(
      {
        "GET /api/v1/permissions": {
          data: { permissions: [{ key: "repository.read", description: "Read repositories." }] },
        },
        "GET /api/v1/users": { data: [user], pagination },
        "POST /api/v1/users": { data: { user, temporaryPassword: "tmp" } },
        "PATCH /api/v1/users/u-1": { data: user },
        "POST /api/v1/users/u-1/active": { data: user },
        "POST /api/v1/users/u-1/password": { data: { ok: true, temporaryPassword: null } },
        "GET /api/v1/orgs/org-1/memberships": { data: [user], pagination },
        "POST /api/v1/orgs/org-1/memberships": { data: { ok: true } },
        "DELETE /api/v1/orgs/org-1/memberships/u-1": { data: { ok: true } },
        "GET /api/v1/orgs/org-1/groups": { data: [group], pagination },
        "POST /api/v1/orgs/org-1/groups": { data: group },
        "PATCH /api/v1/orgs/org-1/groups/g-1": { data: group },
        "DELETE /api/v1/orgs/org-1/groups/g-1": { data: { ok: true } },
        "GET /api/v1/orgs/org-1/groups/g-1/members": { data: [user], pagination },
        "POST /api/v1/orgs/org-1/groups/g-1/members": { data: { ok: true } },
        "DELETE /api/v1/orgs/org-1/groups/g-1/members/u-1": { data: { ok: true } },
        "GET /api/v1/orgs/org-1/groups/g-1/permissions": { data: [grant], pagination },
        "PUT /api/v1/orgs/org-1/groups/g-1/permissions": { data: { ok: true } },
      },
      calls,
    );

    await expect(client.permissionCatalog()).resolves.toEqual({
      permissions: [{ key: "repository.read", description: "Read repositories." }],
    });
    await expect(client.users({ limit: 200, q: "ali" })).resolves.toEqual({
      users: [user],
      pagination,
    });
    await expect(client.createUser({ username: "alice" })).resolves.toEqual({
      user,
      temporaryPassword: "tmp",
    });
    await expect(client.updateUser("u-1", { displayName: "A" })).resolves.toEqual({ user });
    await expect(client.setUserActive("u-1", false)).resolves.toEqual({ user });
    await expect(client.resetUserPassword("u-1", "email")).resolves.toEqual({
      ok: true,
      temporaryPassword: null,
    });
    await expect(client.orgMembers("org-1")).resolves.toEqual({ users: [user], pagination });
    await expect(client.addOrgMember("org-1", "u-1")).resolves.toEqual({ ok: true });
    await expect(client.removeOrgMember("org-1", "u-1")).resolves.toEqual({ ok: true });
    await expect(client.groups("org-1")).resolves.toEqual({ groups: [group], pagination });
    await expect(client.createGroup("org-1", { slug: "devs" })).resolves.toEqual({ group });
    await expect(client.updateGroup("org-1", "g-1", {})).resolves.toEqual({ group });
    await expect(client.deleteGroup("org-1", "g-1")).resolves.toEqual({ ok: true });
    await expect(client.groupMembers("org-1", "g-1")).resolves.toEqual({
      users: [user],
      pagination,
    });
    await expect(client.addGroupMember("org-1", "g-1", "u-1")).resolves.toEqual({ ok: true });
    await expect(client.removeGroupMember("org-1", "g-1", "u-1")).resolves.toEqual({ ok: true });
    await expect(client.groupPermissions("org-1", "g-1")).resolves.toEqual({
      grants: [grant],
      pagination,
    });
    await expect(client.replaceGroupPermissions("org-1", "g-1", [grant])).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      "GET /api/v1/permissions",
      "GET /api/v1/users?limit=200&q=ali",
      "POST /api/v1/users",
      "PATCH /api/v1/users/u-1",
      "POST /api/v1/users/u-1/active",
      "POST /api/v1/users/u-1/password",
      "GET /api/v1/orgs/org-1/memberships",
      "POST /api/v1/orgs/org-1/memberships",
      "DELETE /api/v1/orgs/org-1/memberships/u-1",
      "GET /api/v1/orgs/org-1/groups",
      "POST /api/v1/orgs/org-1/groups",
      "PATCH /api/v1/orgs/org-1/groups/g-1",
      "DELETE /api/v1/orgs/org-1/groups/g-1",
      "GET /api/v1/orgs/org-1/groups/g-1/members",
      "POST /api/v1/orgs/org-1/groups/g-1/members",
      "DELETE /api/v1/orgs/org-1/groups/g-1/members/u-1",
      "GET /api/v1/orgs/org-1/groups/g-1/permissions",
      "PUT /api/v1/orgs/org-1/groups/g-1/permissions",
    ]);
  });

  test("sends JSON bodies with the content-type header and none otherwise", async () => {
    const seen: Array<{ headers: Record<string, string>; body: unknown }> = [];
    const client = createHootifactoryClient(async (path, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      seen.push({
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      if (path === "/api/auth/login") {
        return Response.json({ user: { id: UUID, username: "alice" } });
      }
      return Response.json({ ok: true });
    });

    await client.login("alice", "pw");
    await client.logout();

    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.body).toEqual({ username: "alice", password: "pw" });
    expect(seen[1]?.headers["content-type"]).toBeUndefined();
    expect(seen[1]?.body).toBeUndefined();
  });

  test("defaults to the global fetch when no fetch function is supplied", async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string) => {
      seen.push(String(input));
      return Response.json({ data: [] });
    }) as typeof fetch;
    try {
      const client = createHootifactoryClient();
      await expect(client.orgs()).resolves.toEqual({ orgs: [] });
      expect(seen).toEqual(["/api/v1/orgs"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
