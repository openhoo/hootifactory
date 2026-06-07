import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import {
  createOrganizationWithOwner,
  getOrganizationById,
  listAccessibleOrgs,
  mergeAccessibleOrgs,
} from "./organizations";

describe("accessible org listing", () => {
  test("deduplicates local and external grants by strongest role and sorts by slug", () => {
    expect(
      mergeAccessibleOrgs(
        [
          { id: "org-2", slug: "zeta", displayName: "Zeta", role: "admin" },
          { id: "org-1", slug: "alpha", displayName: "Alpha", role: "viewer" },
        ],
        [
          { id: "org-1", slug: "alpha", displayName: "Alpha", role: "developer" },
          { id: "org-3", slug: "middle", displayName: "Middle", role: "owner" },
        ],
      ),
    ).toEqual([
      { id: "org-1", slug: "alpha", displayName: "Alpha", role: "developer" },
      { id: "org-3", slug: "middle", displayName: "Middle", role: "owner" },
      { id: "org-2", slug: "zeta", displayName: "Zeta", role: "admin" },
    ]);
  });

  test("keeps local membership when it outranks an external grant", () => {
    expect(
      mergeAccessibleOrgs(
        [{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "owner" }],
        [{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "viewer" }],
      ),
    ).toEqual([{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "owner" }]);
  });
});

describe("listAccessibleOrgs", () => {
  test("merges membership and external grants, keeping the strongest role per org", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([
        { id: "org-1", slug: "alpha", displayName: "Alpha", role: "viewer" },
        { id: "org-2", slug: "beta", displayName: "Beta", role: "admin" },
      ]);
      fake.queue([{ id: "org-1", slug: "alpha", displayName: "Alpha", role: "owner" }]);
      const orgs = await listAccessibleOrgs("user-1");
      expect(orgs).toEqual([
        { id: "org-1", slug: "alpha", displayName: "Alpha", role: "owner" },
        { id: "org-2", slug: "beta", displayName: "Beta", role: "admin" },
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
  test("inserts the org then an owner membership in one transaction", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-9", slug: "gamma", displayName: "Gamma" }]); // org insert
      fake.queue([]); // membership insert
      const org = await createOrganizationWithOwner({
        slug: "gamma",
        displayName: "Gamma",
        description: "desc",
        ownerUserId: "owner-1",
      });
      expect(org.id).toBe("org-9");
      const [orgInsert, memberInsert] = fake.queries;
      expect(orgInsert!.kind).toBe("insert");
      expect((orgInsert!.values as Record<string, unknown>).slug).toBe("gamma");
      expect(memberInsert!.kind).toBe("insert");
      expect(memberInsert!.values).toMatchObject({
        orgId: "org-9",
        userId: "owner-1",
        role: "owner",
      });
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
