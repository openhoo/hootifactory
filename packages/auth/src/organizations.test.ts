import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import {
  createOrganizationWithOwner,
  getOrganizationById,
  listAccessibleOrgs,
  ORG_OWNER_PERMISSIONS,
} from "./organizations";

describe("listAccessibleOrgs", () => {
  test("returns membership orgs with sorted effective permission keys", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([
        { id: "org-2", slug: "zeta", displayName: "Zeta" },
        { id: "org-1", slug: "alpha", displayName: "Alpha" },
      ]);
      fake.queue([{ permission: "repository.write" }, { permission: "org.read" }]);
      fake.queue([{ permission: "token.read" }, { permission: "repository.read" }]);
      fake.queue([]);
      fake.queue([]);

      const orgs = await listAccessibleOrgs("user-1");

      expect(orgs).toEqual([
        {
          id: "org-1",
          slug: "alpha",
          displayName: "Alpha",
          permissions: ["repository.read", "token.read"],
        },
        {
          id: "org-2",
          slug: "zeta",
          displayName: "Zeta",
          permissions: ["org.read", "repository.write"],
        },
      ]);
    });
  });
});

describe("getOrganizationById", () => {
  test("returns the row or null", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-1", slug: "alpha" }]);
      expect((await getOrganizationById("org-1"))?.id).toBe("org-1");
      fake.queue([]);
      expect(await getOrganizationById("missing")).toBeNull();
    });
  });
});

describe("createOrganizationWithOwner", () => {
  test("inserts the org, membership, and owner permission grants in one transaction", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-9", slug: "gamma", displayName: "Gamma" }]);
      fake.queue([]);
      fake.queue([]);

      const org = await createOrganizationWithOwner({
        slug: "gamma",
        displayName: "Gamma",
        description: "desc",
        ownerUserId: "owner-1",
      });

      expect(org.id).toBe("org-9");
      const [orgInsert, memberInsert, grantInsert] = fake.queries;
      expect(orgInsert!.kind).toBe("insert");
      expect((orgInsert!.values as Record<string, unknown>).slug).toBe("gamma");
      expect(memberInsert!.kind).toBe("insert");
      expect(memberInsert!.values).toMatchObject({
        orgId: "org-9",
        userId: "owner-1",
      });
      expect(grantInsert!.kind).toBe("insert");
      const grants = grantInsert!.values as Array<Record<string, unknown>>;
      expect(grants).toHaveLength(ORG_OWNER_PERMISSIONS.length);
      expect(grants[0]).toMatchObject({ orgId: "org-9", userId: "owner-1" });
    });
  });

  test("throws when the org insert returns no row", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      await expect(
        createOrganizationWithOwner({ slug: "x", displayName: "X", ownerUserId: "u" }),
      ).rejects.toThrow("failed to create org");
    });
  });
});
