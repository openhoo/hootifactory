import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
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
        role: null,
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

  test("authorizes a write on the org token resource for users", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // membership
      fake.queue([{ role: "owner" }]); // org binding
      fake.queue([]); // external grants
      const decision = await authorizeTokenCreation(user, "org-1");
      expect(decision.allowed).toBe(true);
    });
  });
});

describe("tokenResourceDecision", () => {
  test("self-owned tokens require only the requested action", async () => {
    await withFakeDb(db, async (fake) => {
      // user owns the token -> tokenTarget "self" -> requiredAction stays "read".
      fake.queue([{ role: "viewer" }]); // membership read -> viewer can read
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      const decision = await tokenResourceDecision(
        user,
        tokenRow({ ownerUserId: "user-1" }),
        "read",
      );
      expect(decision.allowed).toBe(true);
    });
  });

  test("org-owned tokens require admin", async () => {
    await withFakeDb(db, async (fake) => {
      // token owned by someone else -> tokenTarget "org" -> requiredAction "admin".
      fake.queue([{ role: "viewer" }]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
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

  test("returns ok when the requested grant is within the creator's role", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ role: "owner" }]); // membership (resolveUserRole inside validateTokenGrant)
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      const result = await validateCreatedTokenGrant({
        principal: user,
        orgId: "org-1",
        grants: [{ resource: "token", target: "self", actions: ["read"] }],
      });
      expect(result).toEqual({ ok: true, value: undefined });
    });
  });

  test("maps a grant violation to a forbidden decision", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ role: "viewer" }]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      const result = await validateCreatedTokenGrant({
        principal: user,
        orgId: "org-1",
        grants: [{ resource: "token", target: "self", actions: ["write"] }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.decision.code).toBe("forbidden");
        expect(result.decision.reason).toContain("scope action 'write'");
      }
    });
  });
});

describe("visibleTokensForPrincipal", () => {
  test("org admins see all org tokens", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ role: "admin" }]); // membership -> admin
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      fake.queue([{ token: tokenRow(), ownerUsername: "alice" }]); // listOrgTokens
      const result = await visibleTokensForPrincipal(user, "org-1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toHaveLength(1);
    });
  });

  test("a read-only org user sees only their own tokens", async () => {
    await withFakeDb(db, async (fake) => {
      // admin authorize -> viewer (denied admin).
      fake.queue([{ role: "viewer" }]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      // read authorize on the org -> viewer can read.
      fake.queue([{ role: "viewer" }]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      fake.queue([{ token: tokenRow(), ownerUsername: "alice" }]); // listOrgTokensOwnedBy
      const result = await visibleTokensForPrincipal(user, "org-1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toHaveLength(1);
    });
  });

  test("a user without org read access is denied", async () => {
    await withFakeDb(db, async (fake) => {
      // admin authorize -> denied.
      fake.queue([]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      // read authorize -> still denied (no role).
      fake.queue([]); // membership
      fake.queue([]); // org binding
      fake.queue([]); // external grants
      const result = await visibleTokensForPrincipal(user, "org-1");
      expect(result.ok).toBe(false);
    });
  });

  test("non-user principals that are not org admins are denied", async () => {
    await withFakeDb(db, async (fake) => {
      const robot: Principal = {
        kind: "token",
        tokenId: "tok-1",
        orgId: "org-1",
        ownerUserId: null,
        grants: [],
        role: "viewer",
        isRobot: true,
      };
      // admin authorize for token: org binding/repo binding reads then falls to role.
      fake.queue([]); // repo binding (none, no repositoryId though) -> org binding read
      fake.queue([]); // org binding
      const result = await visibleTokensForPrincipal(robot, "org-1");
      expect(result.ok).toBe(false);
    });
  });
});
