import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import type { PermissionGrantRow } from "./permission-grants";
import type { Principal } from "./principal";
import {
  authorizeTokenCreation,
  principalActor,
  tokenResourceDecision,
  validateCreatedTokenGrant,
  visibleTokensForPrincipal,
} from "./token-management";
import type { ApiTokenRow } from "./tokens";

const user: Principal = { kind: "user", userId: "user-1", username: "alice" };
const anonymous: Principal = { kind: "anonymous" };

function tokenRow(overrides: Partial<ApiTokenRow> = {}): ApiTokenRow {
  return {
    id: "tok-1",
    orgId: "org-1",
    ownerUserId: "user-1",
    ...overrides,
  } as ApiTokenRow;
}

function grant(overrides: Partial<PermissionGrantRow> = {}): PermissionGrantRow {
  return {
    id: "g1",
    orgId: "org-1",
    userId: "user-1",
    groupId: null,
    tokenId: null,
    permission: "token.read",
    repositoryId: null,
    repositoryPattern: null,
    packagePattern: null,
    artifactPattern: null,
    policy: null,
    tokenTarget: "org",
    targetTokenId: null,
    grantedByUserId: null,
    source: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("principalActor", () => {
  test("maps user, token, and anonymous principals to actor ids", () => {
    expect(principalActor(user)).toEqual({ userId: "user-1", tokenId: null });
    expect(
      principalActor({
        kind: "token",
        tokenId: "tok-9",
        orgId: "o",
        ownerUserId: null,
        grants: [],
        isRobot: false,
      }),
    ).toEqual({ userId: null, tokenId: "tok-9" });
    expect(principalActor(anonymous)).toEqual({ userId: null, tokenId: null });
  });
});

describe("authorizeTokenCreation", () => {
  test("rejects non-user principals as unauthenticated without querying", async () => {
    await withFakeDb(db, async (fake) => {
      const decision = await authorizeTokenCreation(anonymous, "org-1");
      expect(decision).toMatchObject({ allowed: false, code: "unauthenticated" });
      expect(fake.queries.length).toBe(0);
    });
  });

  test("authorizes users with token.create on the org", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ permission: "token.create" })]);
      fake.queue([]);

      const decision = await authorizeTokenCreation(user, "org-1");

      expect(decision.allowed).toBe(true);
    });
  });
});

describe("tokenResourceDecision", () => {
  test("self-owned tokens can use self-targeted token grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ tokenTarget: "self" })]);
      fake.queue([]);

      const decision = await tokenResourceDecision(
        user,
        tokenRow({ ownerUserId: "user-1" }),
        "read",
      );

      expect(decision.allowed).toBe(true);
    });
  });

  test("org-owned tokens require org-targeted token grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ tokenTarget: "self" })]);
      fake.queue([]);

      const decision = await tokenResourceDecision(
        user,
        tokenRow({ ownerUserId: "someone-else" }),
        "read",
      );

      expect(decision.allowed).toBe(false);
    });
  });
});

describe("validateCreatedTokenGrant", () => {
  test("rejects non-user principals", async () => {
    await withFakeDb(db, async () => {
      const result = await validateCreatedTokenGrant({
        principal: anonymous,
        orgId: "org-1",
        grants: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.decision.code).toBe("unauthenticated");
    });
  });

  test("returns ok when requested grants are within the creator's grants", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ permission: "token.rotate", tokenTarget: "self" })]);
      fake.queue([]);

      const result = await validateCreatedTokenGrant({
        principal: user,
        orgId: "org-1",
        grants: [{ permission: "token.rotate", tokenTarget: "self" }],
      });

      expect(result).toEqual({ ok: true, value: undefined });
    });
  });

  test("maps a grant violation to a forbidden decision", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant({ permission: "token.read", tokenTarget: "self" })]);
      fake.queue([]);

      const result = await validateCreatedTokenGrant({
        principal: user,
        orgId: "org-1",
        grants: [{ permission: "token.rotate", tokenTarget: "self" }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.decision.code).toBe("forbidden");
        expect(result.decision.reason).toContain("token.rotate");
      }
    });
  });
});

describe("visibleTokensForPrincipal", () => {
  test("org token readers see all org tokens", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([grant()]);
      fake.queue([]);
      fake.queue([{ token: tokenRow(), ownerUsername: "alice" }]);
      fake.queue([]);

      const result = await visibleTokensForPrincipal(user, "org-1");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toHaveLength(1);
    });
  });

  test("org readers without token.read see only their own tokens", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      fake.queue([]);
      fake.queue([grant({ permission: "org.read", tokenTarget: null })]);
      fake.queue([]);
      fake.queue([{ token: tokenRow(), ownerUsername: "alice" }]);
      fake.queue([]);

      const result = await visibleTokensForPrincipal(user, "org-1");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toHaveLength(1);
    });
  });

  test("a user without org read access is denied", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      fake.queue([]);
      fake.queue([]);
      fake.queue([]);

      const result = await visibleTokensForPrincipal(user, "org-1");

      expect(result.ok).toBe(false);
    });
  });

  test("non-user principals that are not org token readers are denied", async () => {
    await withFakeDb(db, async (fake) => {
      const robot: Principal = {
        kind: "token",
        tokenId: "tok-1",
        orgId: "org-1",
        ownerUserId: null,
        grants: [],
        isRobot: true,
      };
      fake.queue([]);

      const result = await visibleTokensForPrincipal(robot, "org-1");

      expect(result.ok).toBe(false);
    });
  });
});
