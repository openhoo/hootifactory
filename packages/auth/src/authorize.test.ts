import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { authorize, createRequestAuthorizer } from "./authorize";
import { withFakeDb } from "./fake-db";
import type { PermissionGrantRow } from "./permission-grants";
import type { Principal, ResourceRef } from "./principal";

const repoResource: ResourceRef = {
  type: "repository",
  orgId: "org-1",
  repositoryId: "repo-1",
  repositoryName: "acme/app",
};

function grant(overrides: Partial<PermissionGrantRow> = {}): PermissionGrantRow {
  return {
    id: "grant-1",
    orgId: "org-1",
    userId: "u1",
    groupId: null,
    tokenId: null,
    permission: "repository.write",
    repositoryId: null,
    repositoryPattern: "acme/*",
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

describe("authorize", () => {
  test("allows a user with a matching direct permission grant", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant()]);
      fake.queue([]);

      const decision = await authorize(
        { kind: "user", userId: "u1", username: "a" },
        "write",
        repoResource,
      );

      expect(decision.allowed).toBe(true);
      expect(fake.queries).toHaveLength(2);
    });
  });

  test("allows a user through group permission grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      fake.queue([{ groupId: "group-1" }]);
      fake.queue([grant({ userId: null, groupId: "group-1" })]);

      const decision = await authorize(
        { kind: "user", userId: "u1", username: "a" },
        "write",
        repoResource,
      );

      expect(decision.allowed).toBe(true);
      expect(fake.queries).toHaveLength(3);
    });
  });

  test("denies when no grant implies the required permission", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ permission: "repository.read" })]);
      fake.queue([]);

      const decision = await authorize(
        { kind: "user", userId: "u1", username: "a" },
        "write",
        repoResource,
      );

      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("insufficient_scope");
    });
  });

  test("caps owner-backed tokens by the owner's current grants", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = {
        kind: "token",
        tokenId: "tok-1",
        orgId: "org-1",
        ownerUserId: "owner-1",
        ownerUsername: "owner",
        grants: [],
        isRobot: false,
      };
      fake.queue([grant({ userId: null, tokenId: "tok-1" })]);
      fake.queue([grant({ userId: "owner-1", repositoryPattern: "other/*" })]);
      fake.queue([]);

      const decision = await authorize(principal, "write", repoResource);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("token owner");
    });
  });
});

describe("createRequestAuthorizer", () => {
  test("memoizes identical permission checks within a request", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = { kind: "user", userId: "u1", username: "a" };
      fake.queue([grant({ permission: "repository.read" })]);
      fake.queue([]);

      const requestAuthorize = createRequestAuthorizer(principal);
      const first = await requestAuthorize("read", repoResource);
      const second = await requestAuthorize("read", repoResource);

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(fake.queries).toHaveLength(2);
    });
  });

  test("memoization is keyed by resource scope", async () => {
    await withFakeDb(db, async (fake) => {
      const principal: Principal = { kind: "user", userId: "u1", username: "a" };
      const other: ResourceRef = { ...repoResource, repositoryName: "other/app" };
      fake.queue([grant({ permission: "repository.read" })]);
      fake.queue([]);
      fake.queue([grant({ permission: "repository.read", repositoryPattern: "other/*" })]);
      fake.queue([]);

      const requestAuthorize = createRequestAuthorizer(principal);
      expect((await requestAuthorize("read", repoResource)).allowed).toBe(true);
      expect((await requestAuthorize("read", other)).allowed).toBe(true);
      expect(fake.queries).toHaveLength(4);
    });
  });
});
