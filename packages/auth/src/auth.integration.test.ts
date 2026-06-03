import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiTokens,
  db,
  eq,
  externalIdentities,
  memberships,
  organizations,
  repositories,
  roleBindings,
  users,
} from "@hootifactory/db";
import { authorize, effectiveRoleFor, resolveUserRole } from "./authorize";
import {
  consumeAuthEmailToken,
  createAuthEmailToken,
  resetPasswordWithToken,
} from "./email-tokens";
import {
  OIDC_PROVIDER,
  OidcEmailLinkRequiredError,
  oidcIdentityBelongsToAnotherUser,
  syncOidcUser,
} from "./oidc";
import { hashPassword, verifyPassword } from "./password";
import type { Principal } from "./principal";
import { issueRegistryToken, registryJwks, verifyRegistryToken } from "./registry-jwt";
import { createSession, resolveSession, revokeSession } from "./sessions";
import { createApiToken, resolveToken, revokeToken } from "./tokens";
import {
  authenticateUserPassword,
  createLocalUser,
  findPasswordResetUser,
  userPrincipalById,
} from "./users";

let orgId = "";
let userId = "";
let secondOrgId = "";
let orgSlug = "";
let secondOrgSlug = "";
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `test-${crypto.randomUUID().slice(0, 8)}`, displayName: "Test Org" })
    .returning();
  orgId = org!.id;
  orgSlug = org!.slug;
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
  secondOrgSlug = secondOrg!.slug;
});

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
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

  test("owner-backed tokens stop resolving when the owner is disabled", async () => {
    const [owner] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@test.dev`,
        username: `disabled-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning();
    await db.insert(memberships).values({ orgId, userId: owner!.id, role: "developer" });
    const { secret } = await createApiToken({
      orgId,
      ownerUserId: owner!.id,
      name: "disabled-owner",
    });

    expect(await resolveToken(secret)).not.toBeNull();
    await db.update(users).set({ isActive: false }).where(eq(users.id, owner!.id));
    expect(await resolveToken(secret)).toBeNull();
    await db.delete(users).where(eq(users.id, owner!.id));
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
      grants: token.grants,
      scopes: [],
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

  test("authorize applies owner role caps to token stored roles", async () => {
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
      name: "repo-capped-authorize",
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
      grants: token.grants,
      scopes: [],
      role: token.role,
      isRobot: false,
    };
    const decision = await authorize(principal, "write", {
      type: "repository",
      orgId,
      repositoryId: repo!.id,
      repositoryName: repo!.name,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("insufficient_role");
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
        grants: [],
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
      grants: [],
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

describe("auth email tokens (DB)", () => {
  test("password reset user lookup only returns active local accounts", async () => {
    const localPassword = "reset-password";
    const local = await createLocalUser({
      email: `${crypto.randomUUID()}@reset.test`,
      username: `reset-${crypto.randomUUID().slice(0, 8)}`,
      password: localPassword,
    });
    cleanupUserIds.push(local.id);
    const [ssoOnly] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@reset.test`,
        username: `sso-only-${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: null,
      })
      .returning();
    cleanupUserIds.push(ssoOnly!.id);
    const [disabled] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@reset.test`,
        username: `disabled-reset-${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: await hashPassword(localPassword),
        isActive: false,
      })
      .returning();
    cleanupUserIds.push(disabled!.id);

    await expect(findPasswordResetUser(local.email)).resolves.toEqual({
      id: local.id,
      email: local.email,
    });
    await expect(findPasswordResetUser(ssoOnly!.email)).resolves.toBeNull();
    await expect(findPasswordResetUser(disabled!.email)).resolves.toBeNull();
  });

  test("password reset tokens are single-use and revoke existing sessions", async () => {
    const oldPassword = "old-password";
    const newPassword = "new-password";
    const [user] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@reset.test`,
        username: `reset-${crypto.randomUUID().slice(0, 8)}`,
        passwordHash: await hashPassword(oldPassword),
      })
      .returning();
    cleanupUserIds.push(user!.id);
    const session = await createSession(user!.id);
    const { secret } = await createAuthEmailToken({
      purpose: "password_reset",
      userId: user!.id,
      email: user!.email,
      ttlSeconds: 60,
    });

    await expect(resetPasswordWithToken(secret, newPassword)).resolves.toEqual({
      userId: user!.id,
    });
    await expect(resolveSession(session.secret)).resolves.toBeNull();

    const [updated] = await db.select().from(users).where(eq(users.id, user!.id)).limit(1);
    expect(await verifyPassword(newPassword, updated!.passwordHash!)).toBe(true);
    await expect(resetPasswordWithToken(secret, "another-password")).resolves.toBeNull();
  });

  test("expired auth email tokens do not consume", async () => {
    const { secret } = await createAuthEmailToken({
      purpose: "oidc_link",
      userId,
      email: `${crypto.randomUUID()}@reset.test`,
      ttlSeconds: -1,
    });

    await expect(consumeAuthEmailToken("oidc_link", secret)).resolves.toBeNull();
  });
});

describe("local users (DB)", () => {
  test("createLocalUser hashes credentials and principal helpers ignore disabled users", async () => {
    const password = "local-user-password";
    const user = await createLocalUser({
      email: `${crypto.randomUUID()}@local.test`,
      username: `local-${crypto.randomUUID().slice(0, 8)}`,
      password,
      displayName: "Local User",
    });
    cleanupUserIds.push(user.id);

    expect(user.passwordHash).not.toBe(password);
    expect(await verifyPassword(password, user.passwordHash!)).toBe(true);
    await expect(authenticateUserPassword(user.username, password)).resolves.toEqual({
      kind: "user",
      userId: user.id,
      username: user.username,
    });
    await expect(authenticateUserPassword(user.username, "wrong-password")).resolves.toBeNull();
    await expect(userPrincipalById(user.id)).resolves.toEqual({
      kind: "user",
      userId: user.id,
      username: user.username,
    });

    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    await expect(authenticateUserPassword(user.username, password)).resolves.toBeNull();
    await expect(userPrincipalById(user.id)).resolves.toBeNull();
  });
});

describe("OIDC user sync (DB)", () => {
  test("detects OIDC identities owned by a different user", async () => {
    const subject = crypto.randomUUID();
    const user = await syncOidcUser({
      issuer: "https://idp.test",
      subject,
      email: `${crypto.randomUUID()}@oidc.test`,
      emailVerified: true,
      username: "owned-identity",
      displayName: "Owned Identity",
      groups: ["developers"],
      grants: [{ org: orgSlug, role: "developer", groups: ["developers"] }],
    });
    cleanupUserIds.push(user.id);
    const [otherUser] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@oidc.test`,
        username: `other-identity-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning();
    cleanupUserIds.push(otherUser!.id);

    await expect(
      oidcIdentityBelongsToAnotherUser({
        issuer: "https://idp.test",
        subject,
        userId: user.id,
      }),
    ).resolves.toBe(false);
    await expect(
      oidcIdentityBelongsToAnotherUser({
        issuer: "https://idp.test",
        subject,
        userId: otherUser!.id,
      }),
    ).resolves.toBe(true);
  });

  test("auto-provisions a mapped user and grants org access", async () => {
    const email = `${crypto.randomUUID()}@oidc.test`;
    const user = await syncOidcUser({
      issuer: "https://idp.test",
      subject: crypto.randomUUID(),
      email,
      emailVerified: true,
      username: "Alice SSO",
      displayName: "Alice SSO",
      groups: ["developers"],
      grants: [{ org: orgSlug, role: "developer", groups: ["developers"] }],
    });
    cleanupUserIds.push(user.id);

    await expect(resolveUserRole(user.id, orgId)).resolves.toBe("developer");
    const [identity] = await db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, user.id))
      .limit(1);
    expect(identity?.provider).toBe(OIDC_PROVIDER);
    expect(identity?.email).toBe(email);
  });

  test("requires confirmation before linking an existing local email", async () => {
    const email = `${crypto.randomUUID()}@oidc.test`;
    const [local] = await db
      .insert(users)
      .values({ email, username: `local-${crypto.randomUUID().slice(0, 8)}` })
      .returning();
    cleanupUserIds.push(local!.id);

    const input: Parameters<typeof syncOidcUser>[0] = {
      issuer: "https://idp.test",
      subject: crypto.randomUUID(),
      email,
      emailVerified: true,
      username: "linked-user",
      displayName: "Linked User",
      groups: ["admins"],
      grants: [{ org: orgSlug, role: "owner", groups: ["admins"] }],
    };

    await expect(syncOidcUser(input)).rejects.toBeInstanceOf(OidcEmailLinkRequiredError);

    const linked = await syncOidcUser(input, { allowExistingEmailLink: true });

    expect(linked.id).toBe(local!.id);
    await expect(resolveUserRole(local!.id, orgId)).resolves.toBe("owner");
  });

  test("email confirmation can link an unverified-idp email conflict", async () => {
    const email = `${crypto.randomUUID()}@oidc.test`;
    const [local] = await db
      .insert(users)
      .values({ email, username: `conflict-${crypto.randomUUID().slice(0, 8)}` })
      .returning();
    cleanupUserIds.push(local!.id);

    const linked = await syncOidcUser(
      {
        issuer: "https://idp.test",
        subject: crypto.randomUUID(),
        email,
        emailVerified: false,
        username: "conflict-user",
        displayName: "Conflict User",
        groups: ["developers"],
        grants: [{ org: orgSlug, role: "developer", groups: ["developers"] }],
      },
      { allowExistingEmailLink: true },
    );

    expect(linked.id).toBe(local!.id);
  });

  test("reconciles stale OIDC grants without deleting local memberships", async () => {
    const email = `${crypto.randomUUID()}@oidc.test`;
    const subject = crypto.randomUUID();
    const user = await syncOidcUser({
      issuer: "https://idp.test",
      subject,
      email,
      emailVerified: true,
      username: "grant-sync",
      displayName: "Grant Sync",
      groups: ["developers", "viewers"],
      grants: [
        { org: orgSlug, role: "developer", groups: ["developers"] },
        { org: secondOrgSlug, role: "viewer", groups: ["viewers"] },
      ],
    });
    cleanupUserIds.push(user.id);
    await db.insert(memberships).values({ orgId, userId: user.id, role: "viewer" });

    await expect(resolveUserRole(user.id, orgId)).resolves.toBe("developer");
    await expect(resolveUserRole(user.id, secondOrgId)).resolves.toBe("viewer");

    await syncOidcUser({
      issuer: "https://idp.test",
      subject,
      email,
      emailVerified: true,
      username: "grant-sync",
      displayName: "Grant Sync",
      groups: ["admins"],
      grants: [{ org: secondOrgSlug, role: "owner", groups: ["admins"] }],
    });

    await expect(resolveUserRole(user.id, orgId)).resolves.toBe("viewer");
    await expect(resolveUserRole(user.id, secondOrgId)).resolves.toBe("owner");
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
