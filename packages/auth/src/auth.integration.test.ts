import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  db,
  eq,
  groupMemberships,
  groups,
  memberships,
  organizations,
  permissionGrants,
  repositories,
  users,
} from "@hootifactory/db";
import type { PermissionKey } from "@hootifactory/types";
import { authorize, createRequestAuthorizer } from "./authorize";
import { syncOidcUser } from "./oidc";
import type { Principal, ResourceRef } from "./principal";
import { validateTokenGrant } from "./token-grants";
import { createApiToken, recordTokenLastUsed, resolveToken, revokeToken } from "./tokens";

let orgId = "";
let orgSlug = "";
let userId = "";
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `test-${crypto.randomUUID().slice(0, 8)}`, displayName: "Test Org" })
    .returning();
  orgId = org!.id;
  orgSlug = org!.slug;

  const [user] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}@test.dev`,
      username: `u-${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning();
  userId = user!.id;
  await db.insert(memberships).values({ orgId, userId });
});

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
});

async function grantUserPermission(
  permission: PermissionKey,
  overrides: Partial<typeof permissionGrants.$inferInsert> = {},
) {
  const [grant] = await db
    .insert(permissionGrants)
    .values({
      orgId,
      userId,
      permission,
      ...overrides,
    })
    .returning();
  return grant!;
}

async function createRepo() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [repo] = await db
    .insert(repositories)
    .values({
      orgId,
      name: `repo-${suffix}`,
      moduleId: "npm",
      mountPath: `npm/test-${suffix}`,
      storagePrefix: `${orgId}/auth-test-${suffix}`,
    })
    .returning();
  return repo!;
}

describe("permission authorization (DB)", () => {
  test("direct user grants allow implied repository actions and deny stronger actions", async () => {
    const repo = await createRepo();
    await grantUserPermission("repository.write", { repositoryPattern: repo.name });

    const principal: Principal = { kind: "user", userId, username: "alice" };
    const resource: ResourceRef = {
      type: "repository",
      orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
    };

    expect((await authorize(principal, "read", resource)).allowed).toBe(true);
    expect((await authorize(principal, "write", resource)).allowed).toBe(true);
    const deleteDecision = await authorize(principal, "delete", resource);
    expect(deleteDecision.allowed).toBe(false);
    expect(deleteDecision.code).toBe("insufficient_scope");
  });

  test("group grants are included in effective user permissions", async () => {
    const repo = await createRepo();
    const [group] = await db
      .insert(groups)
      .values({ orgId, slug: `writers-${crypto.randomUUID().slice(0, 6)}`, displayName: "Writers" })
      .returning();
    await db.insert(groupMemberships).values({ orgId, groupId: group!.id, userId });
    await db.insert(permissionGrants).values({
      orgId,
      groupId: group!.id,
      permission: "repository.write",
      repositoryPattern: repo.name,
    });

    const decision = await authorize({ kind: "user", userId, username: "alice" }, "write", {
      type: "repository",
      orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
    });

    expect(decision.allowed).toBe(true);
  });

  test("request authorizer memoizes identical permission checks", async () => {
    const repo = await createRepo();
    await grantUserPermission("repository.read", { repositoryPattern: repo.name });
    const resource: ResourceRef = {
      type: "repository",
      orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
    };
    const requestAuthorize = createRequestAuthorizer({ kind: "user", userId, username: "alice" });

    const first = await requestAuthorize("read", resource);
    const second = await requestAuthorize("read", resource);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });
});

describe("api tokens (DB)", () => {
  test("create -> resolve -> revoke persists permission grant rows", async () => {
    const { token, secret } = await createApiToken({
      orgId,
      ownerUserId: userId,
      name: "ci",
      grants: [{ permission: "repository.read", repository: "acme/*" }],
    });

    const principal = await resolveToken(secret);
    expect(principal?.kind).toBe("token");
    if (principal?.kind === "token") {
      expect(principal.orgId).toBe(orgId);
      expect(principal.ownerUsername).not.toBeNull();
      expect(principal.grants[0]).toMatchObject({ permission: "repository.read" });
    }
    const grantRows = await db
      .select()
      .from(permissionGrants)
      .where(eq(permissionGrants.tokenId, token.id));
    expect(grantRows).toHaveLength(1);

    await revokeToken(token.id);
    expect(await resolveToken(secret)).toBeNull();
  });

  test("owner-backed token permissions are capped by the owner's current permissions", async () => {
    const repo = await createRepo();
    const [owner] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@test.dev`,
        username: `owner-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning();
    cleanupUserIds.push(owner!.id);
    await db.insert(memberships).values({ orgId, userId: owner!.id });
    await db.insert(permissionGrants).values({
      orgId,
      userId: owner!.id,
      permission: "repository.read",
      repositoryPattern: repo.name,
    });
    const { token } = await createApiToken({
      orgId,
      ownerUserId: owner!.id,
      name: "repo-capped",
      grants: [{ permission: "repository.write", repository: repo.name }],
    });

    const principal: Principal = {
      kind: "token",
      tokenId: token.id,
      orgId,
      ownerUserId: owner!.id,
      grants: [{ permission: "repository.write", repository: repo.name }],
      isRobot: false,
    };
    const decision = await authorize(principal, "write", {
      type: "repository",
      orgId,
      repositoryId: repo.id,
      repositoryName: repo.name,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("token owner");
  });

  test("last-used token bookkeeping is debounced", async () => {
    const { token } = await createApiToken({
      orgId,
      ownerUserId: userId,
      name: "last-used-debounce",
    });
    const firstWrite = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(await recordTokenLastUsed(token.id, firstWrite)).toBe(true);
    expect(await recordTokenLastUsed(token.id, firstWrite + 30_000)).toBe(false);
    expect(await recordTokenLastUsed(token.id, firstWrite + 60_000)).toBe(true);
  });
});

describe("OIDC group sync (DB)", () => {
  test("syncs mapped IdP groups into local groups and group memberships", async () => {
    const subject = crypto.randomUUID();
    const result = await syncOidcUser({
      issuer: "https://idp.test",
      subject,
      email: `${crypto.randomUUID()}@oidc.test`,
      emailVerified: true,
      username: "Alice SSO",
      displayName: "Alice SSO",
      groups: ["developers"],
      grants: [{ org: orgSlug, group: "developers", groups: ["developers"] }],
    });
    cleanupUserIds.push(result.id);

    const [group] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.orgId, orgId), eq(groups.slug, "developers")))
      .limit(1);
    expect(group).toBeDefined();
    const membershipsRows = await db
      .select()
      .from(groupMemberships)
      .where(and(eq(groupMemberships.groupId, group!.id), eq(groupMemberships.userId, result.id)));
    expect(membershipsRows).toHaveLength(1);
  });
});

describe("token grant validation (DB)", () => {
  test("allows grants within caller permissions and rejects stronger grants", async () => {
    const repo = await createRepo();
    await grantUserPermission("repository.read", { repositoryPattern: repo.name });
    const principal: Principal = { kind: "user", userId, username: "alice" };

    await expect(
      validateTokenGrant({
        principal,
        orgId,
        grants: [{ permission: "repository.read", repository: repo.name }],
      }),
    ).resolves.toEqual({ ok: true });

    const result = await validateTokenGrant({
      principal,
      orgId,
      grants: [{ permission: "repository.write", repository: repo.name }],
    });
    expect(result.ok).toBe(false);
  });
});
