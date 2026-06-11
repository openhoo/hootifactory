import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import type { TokenGrant } from "@hootifactory/types";
import {
  addGroupMember,
  addOrgMember,
  bootstrapSystemAdmins,
  createAdminUser,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupInOrg,
  getUserById,
  grantsForGroup,
  listGroupMembers,
  listGroups,
  listOrgMembers,
  listUsers,
  permissionCatalog,
  removeGroupMember,
  removeOrgMember,
  replaceGroupGrants,
  setTemporaryPassword,
  setUserActive,
  tokenGrantToPermissionGrant,
  updateGroup,
  updateUserProfile,
} from "./access-management";
import { withFakeDb } from "./fake-db";
import type { PermissionGrantRow } from "./permission-grants";
import type { Principal } from "./principal";

const userPrincipal: Principal = { kind: "user", userId: "u1", username: "alice" };
const adminPrincipal: Principal = { kind: "user", userId: "admin-1", username: "root" };

function grantRow(overrides: Partial<PermissionGrantRow> = {}): PermissionGrantRow {
  return {
    id: "pg-1",
    orgId: "org-1",
    userId: null,
    groupId: null,
    tokenId: null,
    permission: "repository.write",
    repositoryId: null,
    repositoryPattern: null,
    packagePattern: null,
    artifactPattern: null,
    policy: null,
    tokenTarget: null,
    targetTokenId: null,
    grantedByUserId: null,
    source: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** The recorded query kinds, in order, as a comparable string. */
function kinds(fake: { queries: ReadonlyArray<{ kind: string }> }): string {
  return fake.queries.map((q) => q.kind).join(",");
}

describe("permissionCatalog", () => {
  test("exposes a non-empty list of {key, description} entries", () => {
    expect(permissionCatalog.length).toBeGreaterThan(0);
    for (const entry of permissionCatalog) {
      expect(typeof entry.key).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("listUsers", () => {
  test("issues a single select with no filter when no query is given", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1" }]);
      const rows = await listUsers({ limit: 10, offset: 0 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("u1");
      expect(kinds(fake)).toBe("select");
    });
  });

  test("still issues a single select when a query string builds filters", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      const rows = await listUsers({ query: "ali", limit: 5, offset: 5 });
      expect(rows).toEqual([]);
      expect(kinds(fake)).toBe("select");
    });
  });
});

describe("getUserById", () => {
  test("returns the row when found", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1" }]);
      expect((await getUserById("u1"))?.id).toBe("u1");
    });
  });

  test("returns null when no row matches", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await getUserById("nope")).toBeNull();
    });
  });
});

describe("createAdminUser", () => {
  test("creates a user without a password when passwordMode is none", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", username: "bob" }]);
      const result = await createAdminUser({
        username: "bob",
        email: "bob@example.com",
        passwordMode: "none",
      });
      expect(result.user.id).toBe("u1");
      expect(result.temporaryPassword).toBeNull();
      expect(fake.queries[0]?.kind).toBe("insert");
      const values = fake.queries[0]?.values as { passwordHash: string | null } | undefined;
      expect(values?.passwordHash).toBeNull();
    });
  });

  test("creates a temporary password and hashes it when requested", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u2", username: "carol" }]);
      const result = await createAdminUser({
        username: "carol",
        email: "carol@example.com",
        displayName: "Carol",
        passwordMode: "temporary",
      });
      expect(result.temporaryPassword).toBeTruthy();
      const values = fake.queries[0]?.values as { passwordHash: string | null } | undefined;
      expect(values?.passwordHash).toBeTruthy();
    });
  });

  test("throws when the insert returns nothing", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      await expect(
        createAdminUser({ username: "x", email: "x@example.com", passwordMode: "none" }),
      ).rejects.toThrow("failed to create user");
    });
  });
});

describe("updateUserProfile", () => {
  test("returns the updated row", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", displayName: "New" }]);
      const row = await updateUserProfile("u1", { displayName: "New" });
      expect(row?.id).toBe("u1");
      expect(row?.displayName).toBe("New");
      expect(fake.queries[0]?.kind).toBe("update");
    });
  });

  test("returns null when the user does not exist", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await updateUserProfile("nope", { email: "a@b.c" })).toBeNull();
    });
  });
});

describe("setTemporaryPassword", () => {
  test("returns the generated password when the user exists", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1" }]);
      const password = await setTemporaryPassword("u1");
      expect(password).toBeTruthy();
      expect(fake.queries[0]?.kind).toBe("update");
    });
  });

  test("returns null when the user does not exist", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await setTemporaryPassword("nope")).toBeNull();
    });
  });
});

describe("setUserActive", () => {
  // The deactivation query order: users update, sessions revoked, api tokens
  // revoked, three snapshot selects (group memberships, org memberships,
  // grants), the snapshot insert, then three cascade deletes.
  const DEACTIVATION_KINDS =
    "update,update,update,select,select,select,insert,delete,delete,delete";

  function groupMembershipRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "gm-1",
      orgId: "org-1",
      groupId: "g-1",
      userId: "u1",
      source: "local",
      provider: null,
      externalKey: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  test("reactivating without a snapshot restores nothing (legacy deactivations)", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: true }]);
      fake.queue([]); // no snapshot row to consume
      const user = await setUserActive("u1", true);
      expect(user?.id).toBe("u1");
      expect(user?.isActive).toBe(true);
      expect(kinds(fake)).toBe("update,delete");
    });
  });

  test("deactivating snapshots memberships and grants before deleting them", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: false }]);
      fake.queue([]); // sessions revocation update
      fake.queue([]); // api tokens revocation update
      fake.queue([groupMembershipRow()]); // group memberships select
      fake.queue([{ id: "m-1", orgId: "org-1", userId: "u1" }]); // memberships select
      fake.queue([
        grantRow({ id: "pg-user", userId: "u1", grantedByUserId: "admin-1" }),
        grantRow({
          id: "pg-admin",
          orgId: null,
          userId: "u1",
          permission: "system.admin",
          source: "bootstrap",
        }),
      ]); // grants select
      const user = await setUserActive("u1", false);
      expect(user?.id).toBe("u1");
      expect(kinds(fake)).toBe(DEACTIVATION_KINDS);
      const snapshotInsert = fake.queries.find((q) => q.kind === "insert");
      expect(snapshotInsert?.onConflictDoNothing).toBe(true);
      expect(snapshotInsert?.values).toEqual({
        userId: "u1",
        memberships: [{ orgId: "org-1" }],
        groupMemberships: [
          { orgId: "org-1", groupId: "g-1", source: "local", provider: null, externalKey: null },
        ],
        permissionGrants: [
          {
            orgId: "org-1",
            permission: "repository.write",
            repositoryId: null,
            repositoryPattern: null,
            packagePattern: null,
            artifactPattern: null,
            policy: null,
            tokenTarget: null,
            targetTokenId: null,
            grantedByUserId: "admin-1",
            source: null,
          },
          {
            orgId: null,
            permission: "system.admin",
            repositoryId: null,
            repositoryPattern: null,
            packagePattern: null,
            artifactPattern: null,
            policy: null,
            tokenTarget: null,
            targetTokenId: null,
            grantedByUserId: null,
            source: "bootstrap",
          },
        ],
        deactivatedAt: expect.any(Date),
      });
    });
  });

  test("deactivating an already-deactivated user keeps the original snapshot", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: false }]);
      // The first deactivation already emptied memberships and grants, so the
      // three snapshot selects return nothing and the insert carries empty
      // arrays — ON CONFLICT DO NOTHING preserves the original snapshot.
      const user = await setUserActive("u1", false);
      expect(user?.id).toBe("u1");
      expect(kinds(fake)).toBe(DEACTIVATION_KINDS);
      const snapshotInsert = fake.queries.find((q) => q.kind === "insert");
      expect(snapshotInsert?.onConflictDoNothing).toBe(true);
      expect(snapshotInsert?.values).toEqual({
        userId: "u1",
        memberships: [],
        groupMemberships: [],
        permissionGrants: [],
        deactivatedAt: expect.any(Date),
      });
    });
  });

  test("reactivating restores the snapshot, skips deleted references, and consumes it", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: true }]); // users update
      fake.queue([
        {
          userId: "u1",
          memberships: [{ orgId: "org-1" }, { orgId: "org-gone" }],
          groupMemberships: [
            { orgId: "org-1", groupId: "g-1", source: "local", provider: null, externalKey: null },
            {
              orgId: "org-1",
              groupId: "g-gone",
              source: "oidc",
              provider: "oidc",
              externalKey: "team-a",
            },
          ],
          permissionGrants: [
            {
              orgId: null,
              permission: "system.admin",
              repositoryId: null,
              repositoryPattern: null,
              packagePattern: null,
              artifactPattern: null,
              policy: null,
              tokenTarget: null,
              targetTokenId: null,
              grantedByUserId: null,
              source: "bootstrap",
            },
            {
              orgId: "org-1",
              permission: "repository.write",
              repositoryId: "repo-1",
              repositoryPattern: null,
              packagePattern: null,
              artifactPattern: null,
              policy: null,
              tokenTarget: null,
              targetTokenId: null,
              grantedByUserId: "ghost",
              source: null,
            },
            {
              orgId: "org-gone",
              permission: "repository.read",
              repositoryId: null,
              repositoryPattern: null,
              packagePattern: null,
              artifactPattern: null,
              policy: null,
              tokenTarget: null,
              targetTokenId: null,
              grantedByUserId: "admin-1",
              source: null,
            },
          ],
          deactivatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ]); // snapshot delete ... returning
      fake.queue([{ id: "org-1" }]); // organizations select: org-gone deleted
      fake.queue([]); // memberships insert
      fake.queue([{ id: "g-1", orgId: "org-1" }]); // groups select: g-gone deleted
      fake.queue([]); // group memberships insert
      fake.queue([{ id: "repo-1" }]); // repositories select
      fake.queue([{ id: "admin-1" }]); // granter users select: ghost deleted
      fake.queue([]); // permission grants insert

      const user = await setUserActive("u1", true);
      expect(user?.id).toBe("u1");
      expect(kinds(fake)).toBe("update,delete,select,insert,select,insert,select,select,insert");

      const inserts = fake.queries.filter((q) => q.kind === "insert");
      expect(inserts.every((q) => q.onConflictDoNothing)).toBe(true);
      expect(inserts[0]?.values).toEqual([{ orgId: "org-1", userId: "u1" }]);
      expect(inserts[1]?.values).toEqual([
        {
          orgId: "org-1",
          groupId: "g-1",
          userId: "u1",
          source: "local",
          provider: null,
          externalKey: null,
        },
      ]);
      expect(inserts[2]?.values).toEqual([
        {
          userId: "u1",
          orgId: null,
          permission: "system.admin",
          repositoryId: null,
          repositoryPattern: null,
          packagePattern: null,
          artifactPattern: null,
          policy: null,
          tokenTarget: null,
          targetTokenId: null,
          grantedByUserId: null,
          source: "bootstrap",
        },
        {
          userId: "u1",
          orgId: "org-1",
          permission: "repository.write",
          repositoryId: "repo-1",
          repositoryPattern: null,
          packagePattern: null,
          artifactPattern: null,
          policy: null,
          tokenTarget: null,
          targetTokenId: null,
          // The granting user was deleted while u1 was inactive; the grant is
          // restored with a null granter instead of a dangling FK.
          grantedByUserId: null,
          source: null,
        },
      ]);
    });
  });

  test("reactivating restores nothing when the snapshot is empty", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: true }]);
      fake.queue([
        {
          userId: "u1",
          memberships: [],
          groupMemberships: [],
          permissionGrants: [],
          deactivatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ]);
      const user = await setUserActive("u1", true);
      expect(user?.isActive).toBe(true);
      // No org/group/grant references to look up and nothing to insert.
      expect(kinds(fake)).toBe("update,delete");
    });
  });

  test("returns null without cascading when the user is missing", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await setUserActive("nope", false)).toBeNull();
      expect(kinds(fake)).toBe("update");
    });
  });
});

describe("org membership helpers", () => {
  test("listOrgMembers selects joined membership/user rows", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ membership: { id: "m1" }, user: { id: "u1" } }]);
      const rows = await listOrgMembers("org-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user.id).toBe("u1");
      expect(fake.queries[0]?.kind).toBe("select");
    });
  });

  test("addOrgMember inserts the membership", async () => {
    await withFakeDb(db, async (fake) => {
      await addOrgMember("org-1", "u1");
      expect(fake.queries[0]?.kind).toBe("insert");
      expect(fake.queries[0]?.values).toEqual({ orgId: "org-1", userId: "u1" });
    });
  });

  test("removeOrgMember deletes group memberships, grants, and the membership", async () => {
    await withFakeDb(db, async (fake) => {
      await removeOrgMember("org-1", "u1");
      expect(kinds(fake)).toBe("delete,delete,delete");
    });
  });
});

describe("group CRUD", () => {
  test("listGroups selects by org", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1" }]);
      const rows = await listGroups("org-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("g1");
    });
  });

  test("getGroupById returns the row or null", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1" }]);
      expect((await getGroupById("g1"))?.id).toBe("g1");
    });
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await getGroupById("g1")).toBeNull();
    });
  });

  test("getGroupInOrg scopes the lookup to the org", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]);
      const group = await getGroupInOrg("org-1", "g1");
      expect(group?.id).toBe("g1");
      expect(group?.orgId).toBe("org-1");
    });
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await getGroupInOrg("org-1", "g1")).toBeNull();
    });
  });

  test("createGroup returns the inserted row", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", slug: "team" }]);
      const group = await createGroup({ orgId: "org-1", slug: "team", displayName: "Team" });
      expect(group.id).toBe("g1");
      expect(group.slug).toBe("team");
      expect(fake.queries[0]?.kind).toBe("insert");
    });
  });

  test("createGroup throws when the insert returns nothing", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      await expect(
        createGroup({ orgId: "org-1", slug: "team", displayName: "Team" }),
      ).rejects.toThrow("failed to create group");
    });
  });

  test("updateGroup returns the updated row or null", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", displayName: "Renamed" }]);
      const group = await updateGroup("org-1", "g1", { displayName: "Renamed" });
      expect(group?.id).toBe("g1");
      expect(group?.displayName).toBe("Renamed");
    });
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await updateGroup("org-1", "g1", { slug: "x" })).toBeNull();
    });
  });

  test("deleteGroup reports whether a row was removed", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1" }]);
      expect(await deleteGroup("org-1", "g1")).toBe(true);
    });
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await deleteGroup("org-1", "g1")).toBe(false);
    });
  });
});

describe("group membership helpers", () => {
  test("listGroupMembers selects joined rows", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ membership: { id: "gm1" }, user: { id: "u1" } }]);
      const rows = await listGroupMembers("org-1", "g1");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user.id).toBe("u1");
    });
  });

  test("addGroupMember adds without a domination check when the group holds no grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group lookup
      fake.queue([]); // group grants (none -> nothing to dominate)
      fake.queue([{ id: "m1" }]); // org membership lookup
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u2",
        principal: userPrincipal,
      });
      expect(result).toEqual({ ok: true });
      // No authorization reads beyond the group-grant lookup itself.
      expect(kinds(fake)).toBe("select,select,select,insert");
      expect(fake.queries.at(-1)?.values).toEqual({ orgId: "org-1", groupId: "g1", userId: "u2" });
    });
  });

  test("addGroupMember reports group_not_found", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // group lookup misses
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u1",
        principal: userPrincipal,
      });
      expect(result).toEqual({ ok: false, code: "group_not_found", error: "group not found" });
      expect(kinds(fake)).toBe("select");
    });
  });

  test("addGroupMember reports user_not_member", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group exists
      fake.queue([]); // group grants (none)
      fake.queue([]); // not an org member
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u1",
        principal: userPrincipal,
      });
      expect(result).toEqual({
        ok: false,
        code: "user_not_member",
        error: "user is not a member of this organization",
      });
      expect(kinds(fake)).toBe("select,select,select");
    });
  });

  test("addGroupMember rejects an actor whose grants do not cover the group's grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group lookup
      fake.queue([grantRow({ groupId: "g1", permission: "repository.write" })]); // group grants
      fake.queue([grantRow({ userId: "u1", permission: "group.member.manage" })]); // actor's direct grants
      fake.queue([]); // actor's group memberships
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u2",
        principal: userPrincipal,
      });
      expect(result).toEqual({
        ok: false,
        code: "grant_escalation",
        error:
          "adding a member to this group would grant permissions beyond your own " +
          "(cannot grant permission 'repository.write' beyond your own access)",
      });
      // group lookup, group grants, actor grants, actor memberships — and no insert.
      expect(kinds(fake)).toBe("select,select,select,select");
    });
  });

  test("addGroupMember rejects a self-add by an under-privileged actor", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group lookup
      fake.queue([grantRow({ groupId: "g1", permission: "repository.write" })]); // group grants
      fake.queue([grantRow({ userId: "u1", permission: "group.member.manage" })]); // actor's direct grants
      fake.queue([]); // actor's group memberships
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u1", // the acting principal's own user id
        principal: userPrincipal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("grant_escalation");
      expect(fake.queries.every((q) => q.kind !== "insert")).toBe(true);
    });
  });

  test("addGroupMember allows an actor whose grants dominate the group's grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group lookup
      fake.queue([grantRow({ groupId: "g1", permission: "repository.read" })]); // group grants
      // repository.write implies repository.read, so the actor dominates.
      fake.queue([grantRow({ userId: "u1", permission: "repository.write" })]); // actor's direct grants
      fake.queue([]); // actor's group memberships
      fake.queue([{ id: "m1" }]); // org membership lookup
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u2",
        principal: userPrincipal,
      });
      expect(result).toEqual({ ok: true });
      expect(kinds(fake)).toBe("select,select,select,select,select,insert");
    });
  });

  test("addGroupMember allows a system.admin actor, even for a system.admin group", async () => {
    const adminGrant = grantRow({ userId: "admin-1", orgId: null, permission: "system.admin" });
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group lookup
      fake.queue([
        grantRow({ groupId: "g1", permission: "repository.write" }),
        grantRow({ id: "pg-2", groupId: "g1", permission: "system.admin" }),
      ]); // group grants
      fake.queue([adminGrant]); // actor's direct grants (repository.write check)
      fake.queue([]); // actor's group memberships (repository.write check)
      fake.queue([adminGrant]); // actor's direct grants (system.admin check, system resource)
      fake.queue([{ id: "m1" }]); // org membership lookup
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u2",
        principal: adminPrincipal,
      });
      expect(result).toEqual({ ok: true });
      expect(kinds(fake)).toBe("select,select,select,select,select,select,insert");
    });
  });

  test("addGroupMember rejects non-user principals when the group holds grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group lookup
      fake.queue([grantRow({ groupId: "g1", permission: "repository.read" })]); // group grants
      const result = await addGroupMember({
        orgId: "org-1",
        groupId: "g1",
        userId: "u2",
        principal: { kind: "anonymous" },
      });
      expect(result).toEqual({
        ok: false,
        code: "grant_escalation",
        error:
          "adding a member to this group would grant permissions beyond your own (login required)",
      });
      expect(kinds(fake)).toBe("select,select");
    });
  });

  // Removal only ever reduces access, so it intentionally has no domination check.
  test("removeGroupMember deletes the row", async () => {
    await withFakeDb(db, async (fake) => {
      await removeGroupMember("org-1", "g1", "u1");
      expect(fake.queries[0]?.kind).toBe("delete");
    });
  });

  test("grantsForGroup selects grants for the org/group", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "pg1" }]);
      const grants = await grantsForGroup("org-1", "g1");
      expect(grants).toHaveLength(1);
      expect(grants[0]?.id).toBe("pg1");
    });
  });
});

describe("tokenGrantToPermissionGrant", () => {
  test("maps a token grant onto a permission-grant row with defaults", () => {
    const grant: TokenGrant = { permission: "repository.write", repository: "acme/*" };
    const row = tokenGrantToPermissionGrant({
      orgId: "org-1",
      groupId: "g1",
      grant,
      grantedByUserId: "admin-1",
    });
    expect(row.orgId).toBe("org-1");
    expect(row.groupId).toBe("g1");
    expect(row.userId).toBeNull();
    expect(row.tokenId).toBeNull();
    expect(row.permission).toBe("repository.write");
    expect(row.repositoryPattern).toBe("acme/*");
    expect(row.packagePattern).toBeNull();
    expect(row.artifactPattern).toBeNull();
    expect(row.grantedByUserId).toBe("admin-1");
  });

  test("threads through package/artifact/policy/token fields", () => {
    const grant: TokenGrant = {
      permission: "token.read",
      package: "left-pad",
      artifact: "sha256:abc",
      policy: "scan",
      tokenTarget: "org",
      tokenId: "tok-1",
    };
    const row = tokenGrantToPermissionGrant({ orgId: "org-1", userId: "u1", grant });
    expect(row.packagePattern).toBe("left-pad");
    expect(row.artifactPattern).toBe("sha256:abc");
    expect(row.policy).toBe("scan");
    expect(row.tokenTarget).toBe("org");
    expect(row.targetTokenId).toBe("tok-1");
    expect(row.userId).toBe("u1");
    expect(row.grantedByUserId).toBeNull();
  });
});

describe("replaceGroupGrants", () => {
  test("returns group_not_found when the group is missing", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // getGroupInOrg miss
      const result = await replaceGroupGrants({
        orgId: "org-1",
        groupId: "g1",
        principal: userPrincipal,
        grants: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("group_not_found");
        expect(result.error).toBe("group not found");
      }
    });
  });

  test("returns invalid_grant when grant validation fails", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group exists
      const result = await replaceGroupGrants({
        orgId: "org-1",
        groupId: "g1",
        principal: { kind: "anonymous" },
        grants: [{ permission: "org.read" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid_grant");
        expect(result.error).toBe("login required");
      }
    });
  });

  test("replaces grants when the group exists and validation passes (empty grant set)", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1", orgId: "org-1" }]); // group exists
      const result = await replaceGroupGrants({
        orgId: "org-1",
        groupId: "g1",
        principal: userPrincipal,
        grants: [],
      });
      expect(result.ok).toBe(true);
      // getGroupInOrg select, then the transaction delete; no insert for an empty grant set.
      expect(kinds(fake)).toBe("select,delete");
    });
  });
});

describe("bootstrapSystemAdmins", () => {
  test("grants system.admin to existing users that lack it", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1" }]); // existing users
      fake.queue([]); // existing admin rows (none)
      fake.queue([]); // managed bootstrap rows (none)
      const result = await bootstrapSystemAdmins(["u1", "u1", "missing"]);
      expect(result.granted).toEqual(["u1"]);
      expect(result.revoked).toEqual([]);
      expect(result.missing).toEqual(["missing"]);
      // last query is the insert of the new grant
      expect(fake.queries.at(-1)?.kind).toBe("insert");
    });
  });

  test("revokes managed grants for users no longer desired", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1" }]); // existing users (desired)
      fake.queue([{ userId: "u1" }]); // u1 already admin
      fake.queue([{ userId: "old" }]); // managed bootstrap rows include a stale user
      const result = await bootstrapSystemAdmins(["u1"]);
      expect(result.revoked).toEqual(["old"]);
      expect(result.granted).toEqual([]);
      expect(fake.queries.some((q) => q.kind === "delete")).toBe(true);
    });
  });

  test("revokes all managed grants when no users are desired", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ userId: "old" }]); // managed bootstrap rows
      const result = await bootstrapSystemAdmins([]);
      expect(result.revoked).toEqual(["old"]);
      expect(result.granted).toEqual([]);
      expect(result.missing).toEqual([]);
      expect(fake.queries.some((q) => q.kind === "delete")).toBe(true);
    });
  });
});
