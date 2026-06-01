import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiTokens,
  db,
  eq,
  memberships,
  organizations,
  repositories,
  roleBindings,
  users,
} from "@hootifactory/db";
import { effectiveRoleFor } from "./authorize";
import { hashPassword, verifyPassword } from "./password";
import type { Principal } from "./principal";
import { issueRegistryToken, registryJwks, verifyRegistryToken } from "./registry-jwt";
import { createSession, resolveSession, revokeSession } from "./sessions";
import { createApiToken, resolveToken, revokeToken } from "./tokens";

let orgId = "";
let userId = "";
let secondOrgId = "";

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `test-${crypto.randomUUID().slice(0, 8)}`, displayName: "Test Org" })
    .returning();
  orgId = org!.id;
  const [u] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}@test.dev`,
      username: `u-${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning();
  userId = u!.id;
  await db.insert(memberships).values({ orgId, userId, role: "owner" });
  const [secondOrg] = await db
    .insert(organizations)
    .values({ slug: `test-${crypto.randomUUID().slice(0, 8)}`, displayName: "Second Test Org" })
    .returning();
  secondOrgId = secondOrg!.id;
});

afterAll(async () => {
  if (secondOrgId) await db.delete(organizations).where(eq(organizations.id, secondOrgId));
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
});

describe("api tokens (DB)", () => {
  test("create -> resolve -> revoke", async () => {
    const { token, secret } = await createApiToken({
      orgId,
      ownerUserId: userId,
      name: "ci",
      scopes: [{ repository: "acme/*", actions: ["read", "write"] }],
    });
    expect(secret.startsWith("hoot_")).toBe(true);

    const principal = await resolveToken(secret);
    expect(principal?.kind).toBe("token");
    if (principal?.kind === "token") {
      expect(principal.orgId).toBe(orgId);
      expect(principal.scopes[0]?.repository).toBe("acme/*");
    }

    await revokeToken(token.id);
    expect(await resolveToken(secret)).toBeNull();
  });

  test("garbage secret resolves to null", async () => {
    expect(await resolveToken("hoot_not-a-real-token")).toBeNull();
    expect(await resolveToken("totally-bogus")).toBeNull();
  });

  test("owner-backed token roles are capped by repo-scoped owner bindings", async () => {
    const [repo] = await db
      .insert(repositories)
      .values({
        orgId,
        name: `repo-${crypto.randomUUID().slice(0, 8)}`,
        format: "npm",
        mountPath: `npm/test-${crypto.randomUUID().slice(0, 8)}`,
        storagePrefix: `${orgId}/auth-test`,
      })
      .returning();
    const { token } = await createApiToken({
      orgId,
      ownerUserId: userId,
      name: "repo-capped",
      scopes: [{ repository: repo!.name, actions: ["read", "write"] }],
      role: "owner",
    });
    await db.insert(roleBindings).values({
      orgId,
      userId,
      repositoryId: repo!.id,
      role: "viewer",
    });

    const principal: Principal = {
      kind: "token",
      tokenId: token.id,
      orgId,
      ownerUserId: userId,
      scopes: token.scopes,
      role: token.role,
      isRobot: false,
    };
    await expect(
      effectiveRoleFor(principal, {
        type: "repository",
        orgId,
        repositoryId: repo!.id,
        repositoryName: repo!.name,
      }),
    ).resolves.toBe("viewer");
  });

  test("token-scoped repo bindings override a token's org role", async () => {
    const [repo] = await db
      .insert(repositories)
      .values({
        orgId,
        name: `repo-${crypto.randomUUID().slice(0, 8)}`,
        format: "npm",
        mountPath: `npm/test-${crypto.randomUUID().slice(0, 8)}`,
        storagePrefix: `${orgId}/auth-test`,
      })
      .returning();
    const [token] = await db
      .insert(apiTokens)
      .values({
        orgId,
        ownerUserId: null,
        name: "robot-bound",
        type: "robot",
        tokenHash: crypto.randomUUID().replaceAll("-", ""),
        tokenPrefix: "hoot_test",
        scopes: [],
        role: "admin",
      })
      .returning();
    await db.insert(roleBindings).values({
      orgId,
      tokenId: token!.id,
      repositoryId: repo!.id,
      role: "viewer",
    });

    const principal: Principal = {
      kind: "token",
      tokenId: token!.id,
      orgId,
      ownerUserId: null,
      scopes: [],
      role: "admin",
      isRobot: true,
    };
    await expect(
      effectiveRoleFor(principal, {
        type: "repository",
        orgId,
        repositoryId: repo!.id,
        repositoryName: repo!.name,
      }),
    ).resolves.toBe("viewer");
  });

  test("repo bindings with a mismatched org are ignored", async () => {
    const [repo] = await db
      .insert(repositories)
      .values({
        orgId: secondOrgId,
        name: `repo-${crypto.randomUUID().slice(0, 8)}`,
        format: "npm",
        mountPath: `npm/test-${crypto.randomUUID().slice(0, 8)}`,
        storagePrefix: `${secondOrgId}/auth-test`,
      })
      .returning();
    await db.insert(roleBindings).values({
      orgId,
      userId,
      repositoryId: repo!.id,
      role: "owner",
    });

    await expect(
      effectiveRoleFor(
        { kind: "user", userId, username: "alice" },
        {
          type: "repository",
          orgId: secondOrgId,
          repositoryId: repo!.id,
          repositoryName: repo!.name,
        },
      ),
    ).resolves.toBeNull();
  });
});

describe("sessions (DB)", () => {
  test("create -> resolve -> revoke", async () => {
    const { secret } = await createSession(userId, { ip: "127.0.0.1" });
    const resolved = await resolveSession(secret);
    expect(resolved?.userId).toBe(userId);
    await revokeSession(secret);
    expect(await resolveSession(secret)).toBeNull();
  });
});

describe("registry JWT (RS256)", () => {
  test("issue -> verify round-trips access claims", async () => {
    const jwt = await issueRegistryToken({
      subject: "alice",
      audience: "hootifactory-registry",
      access: [{ type: "repository", name: "acme/app", actions: ["pull", "push"] }],
    });
    const verified = await verifyRegistryToken(jwt, "hootifactory-registry");
    expect(verified.subject).toBe("alice");
    expect(verified.access[0]?.name).toBe("acme/app");
    expect(verified.access[0]?.actions).toContain("push");
  });

  test("jwks exposes a public RS256 key", async () => {
    const jwks = await registryJwks();
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0]?.alg).toBe("RS256");
  });
});

describe("password hashing", () => {
  test("hash + verify", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(await verifyPassword("s3cret-pw", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
