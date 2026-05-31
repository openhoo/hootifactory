import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, eq, organizations, users } from "@hootifactory/db";
import { hashPassword, verifyPassword } from "./password";
import { issueRegistryToken, registryJwks, verifyRegistryToken } from "./registry-jwt";
import { createSession, resolveSession, revokeSession } from "./sessions";
import { createApiToken, resolveToken, revokeToken } from "./tokens";

let orgId = "";
let userId = "";

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
});

afterAll(async () => {
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
