import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { authorize, createRequestAuthorizer, effectiveRoleFor, resolveUserRole } from "./authorize";
import { withFakeDb } from "./fake-db";
import type { Principal, ResourceRef } from "./principal";

const repoResource: ResourceRef = {
  type: "repository",
  orgId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "acme/app",
};

describe("resolveUserRole", () => {
  test("a repo-scoped binding wins outright over org membership", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ role: "admin" }]); // roleBindingRole (repo-scoped)
      expect(await resolveUserRole("user-1", "org-1", "repo-1")).toBe("admin");
    });
  });

  test("combines org membership, org-wide binding, and external grants (highest wins)", async () => {
    await withFakeDb(db, async (fake) => {
      // No repo scope: resolveUserRole runs Promise.all of three reads in order:
      // memberships, org-wide roleBinding, externalRoleGrants.
      fake.queue([{ role: "viewer" }]); // membership
      fake.queue([{ role: "developer" }]); // org-wide binding
      fake.queue([{ role: "admin" }]); // external grant
      expect(await resolveUserRole("user-1", "org-1")).toBe("admin");
    });
  });

  test("returns null when the user has no role anywhere", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // membership
      fake.queue([]); // org-wide binding
      fake.queue([]); // external grants
      expect(await resolveUserRole("user-1", "org-1")).toBeNull();
    });
  });

  test("falls through to org resolution when the repo-scoped binding is absent", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // repo-scoped binding -> none
      fake.queue([{ role: "developer" }]); // membership
      fake.queue([]); // org-wide binding
      fake.queue([]); // external grants
      expect(await resolveUserRole("user-1", "org-1", "repo-1")).toBe("developer");
    });
  });
});

describe("effectiveRoleFor", () => {
  test("user principals with no org resource resolve to null without querying", async () => {
    await withFakeDb(db, async (fake) => {
      const role = await effectiveRoleFor({ kind: "user", userId: "u1", username: "a" }, {
        type: "org",
      } as ResourceRef);
      expect(role).toBeNull();
      expect(fake.queries.length).toBe(0);
    });
  });

  test("token principals without an org resource return their stored role (no query)", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = {
        kind: "token",
        tokenId: "tok-1",
        orgId: "org-1",
        ownerUserId: null,
        grants: [],
        role: "admin",
        isRobot: true,
      };
      expect(await effectiveRoleFor(principal, { type: "org" } as ResourceRef)).toBe("admin");
      expect(fake.queries.length).toBe(0);
    });
  });

  test("owner-backed token role is capped by the owner's effective role (minRole)", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = {
        kind: "token",
        tokenId: "tok-1",
        orgId: "org-1",
        ownerUserId: "owner-1",
        grants: [],
        role: "owner",
        isRobot: false,
      };
      // Promise.all order: [repo binding, org binding, owner resolveUserRole].
      fake.queue([]); // token repo binding -> none
      fake.queue([]); // token org binding -> none
      // resolveUserRole(owner) with repo scope: repo binding first.
      fake.queue([{ role: "viewer" }]); // owner repo-scoped binding -> viewer
      // role defaults to principal.role ("owner"); owner caps it to viewer.
      expect(await effectiveRoleFor(principal, repoResource)).toBe("viewer");
    });
  });

  test("ownerless token uses its bound or stored role directly", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = {
        kind: "token",
        tokenId: "tok-1",
        orgId: "org-1",
        ownerUserId: null,
        grants: [],
        role: "developer",
        isRobot: true,
      };
      fake.queue([{ role: "admin" }]); // repo binding wins
      fake.queue([]); // org binding
      expect(await effectiveRoleFor(principal, repoResource)).toBe("admin");
    });
  });

  test("anonymous principals always resolve to null", async () => {
    await withFakeDb(db, async () => {
      expect(await effectiveRoleFor({ kind: "anonymous" }, repoResource)).toBeNull();
    });
  });
});

describe("authorize", () => {
  test("allows a write for a developer on a repository", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // repo binding
      fake.queue([{ role: "developer" }]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      const decision = await authorize(
        { kind: "user", userId: "u1", username: "a" },
        "write",
        repoResource,
      );
      expect(decision.allowed).toBe(true);
    });
  });

  test("denies a write for a viewer on a repository", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ role: "viewer" }]); // repo-scoped binding
      const decision = await authorize(
        { kind: "user", userId: "u1", username: "a" },
        "write",
        repoResource,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("insufficient_role");
    });
  });
});

describe("createRequestAuthorizer", () => {
  test("memoizes the effective role per principal+resource within a request", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = { kind: "user", userId: "u1", username: "a" };
      // Only one resolveUserRole (repo binding wins) should ever run despite two calls.
      fake.queue([{ role: "developer" }]);
      const requestAuthorize = createRequestAuthorizer(principal);
      const first = await requestAuthorize("read", repoResource);
      const second = await requestAuthorize("write", repoResource);
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      // The second call reused the cached role -> exactly one query was issued.
      expect(fake.queries.length).toBe(1);
    });
  });

  test("memoization is keyed so distinct resources are resolved separately", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = { kind: "user", userId: "u1", username: "a" };
      const other: ResourceRef = { ...repoResource, repositoryId: "repo-2" };
      fake.queue([{ role: "developer" }]); // repo-1 binding
      fake.queue([{ role: "viewer" }]); // repo-2 binding
      const requestAuthorize = createRequestAuthorizer(principal);
      expect((await requestAuthorize("write", repoResource)).allowed).toBe(true);
      expect((await requestAuthorize("write", other)).allowed).toBe(false);
      expect(fake.queries.length).toBe(2);
    });
  });
});
