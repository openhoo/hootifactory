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
import type { Principal } from "./principal";

const userPrincipal: Principal = { kind: "user", userId: "u1", username: "alice" };

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
  test("reactivating issues only the user update", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: true }]);
      const user = await setUserActive("u1", true);
      expect(user?.id).toBe("u1");
      expect(user?.isActive).toBe(true);
      expect(kinds(fake)).toBe("update");
    });
  });

  test("deactivating cascades session/token/membership/grant cleanup", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u1", isActive: false }]);
      const user = await setUserActive("u1", false);
      expect(user?.id).toBe("u1");
      // users update, sessions revoked, api tokens revoked, then three cascade deletes.
      expect(kinds(fake)).toBe("update,update,update,delete,delete,delete");
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

  test("addGroupMember adds when the group exists and the user is an org member", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1" }]); // group lookup
      fake.queue([{ id: "m1" }]); // membership lookup
      const result = await addGroupMember({ orgId: "org-1", groupId: "g1", userId: "u1" });
      expect(result).toBe("added");
      expect(kinds(fake)).toBe("select,select,insert");
    });
  });

  test("addGroupMember reports group_not_found", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // group lookup misses
      const result = await addGroupMember({ orgId: "org-1", groupId: "g1", userId: "u1" });
      expect(result).toBe("group_not_found");
      expect(kinds(fake)).toBe("select");
    });
  });

  test("addGroupMember reports user_not_member", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "g1" }]); // group exists
      fake.queue([]); // not an org member
      const result = await addGroupMember({ orgId: "org-1", groupId: "g1", userId: "u1" });
      expect(result).toBe("user_not_member");
      expect(kinds(fake)).toBe("select,select");
    });
  });

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
