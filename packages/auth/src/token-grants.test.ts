import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import { validateTokenGrant } from "./token-grants";

// resolveUserRole (no repo scope) issues three reads in order:
// membership, org-wide binding, external grants. We seed the creator's org role
// via the membership read and leave the others empty.
function queueCreatorOrgRole(fake: Parameters<Parameters<typeof withFakeDb>[1]>[0], role: string) {
  fake.queue([{ role }]); // membership
  fake.queue([]); // org-wide binding
  fake.queue([]); // external grants
}

describe("validateTokenGrant", () => {
  test("rejects requesting a role above the creator's own", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "developer");
      // requestedRole present -> repositories read, then roleBindings read.
      fake.queue([]); // org repositories (none)
      const result = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        requestedRole: "owner",
        grants: [],
      });
      expect(result).toEqual({ ok: false, error: "cannot grant a role above your own" });
    });
  });

  test("rejects a grant action beyond the creator's org role", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "developer");
      // grant has repository -> repositories read (empty), no roleBindings read.
      fake.queue([]); // repositories
      const result = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        grants: [{ resource: "repository", repository: "acme/app", actions: ["delete"] }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("cannot grant scope action 'delete' beyond your role");
      }
    });
  });

  test("rejects org token-management grants from non-admin creators", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "developer");
      const result = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        grants: [{ resource: "token", target: "org", actions: ["write"] }],
      });
      expect(result).toEqual({
        ok: false,
        error: "cannot grant org token management beyond your role",
      });
    });
  });

  test("allows self token-management grants for a developer", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "developer");
      const result = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        grants: [{ resource: "token", target: "self", actions: ["read", "write"] }],
      });
      expect(result).toEqual({ ok: true });
    });
  });

  test("caps repo-scoped grants by the creator's effective role on that repo", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "developer");
      // grants include a repository -> repositories read, then roleBindings read.
      fake.queue([{ id: "repo-1", name: "acme/app", mountPath: "npm/acme/app" }]); // repositories
      fake.queue([{ repositoryId: "repo-1", role: "viewer" }]); // per-repo bindings
      const writeGrant = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        grants: [{ resource: "repository", repository: "acme/app", actions: ["write"] }],
      });
      expect(writeGrant.ok).toBe(false);
      if (!writeGrant.ok) {
        expect(writeGrant.error).toBe("cannot grant scope action 'write' on repository 'acme/app'");
      }
    });
  });

  test("rejects a requested role above the creator's role on some org repo", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "admin");
      fake.queue([{ id: "repo-1", name: "acme/app", mountPath: "npm/acme/app" }]); // repositories
      fake.queue([{ repositoryId: "repo-1", role: "viewer" }]); // per-repo bindings
      const result = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        requestedRole: "admin",
        grants: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("cannot grant role 'admin' on repository 'acme/app'");
      }
    });
  });

  test("returns ok for a grant fully within the creator's role and no repos to check", async () => {
    await withFakeDb(db, async (fake) => {
      queueCreatorOrgRole(fake, "owner");
      // grant carries a repository but the org has no repos -> empty repositories read.
      fake.queue([]); // repositories
      const result = await validateTokenGrant({
        userId: "u1",
        orgId: "org-1",
        grants: [{ resource: "repository", repository: "acme/*", actions: ["read", "write"] }],
      });
      expect(result).toEqual({ ok: true });
    });
  });
});
