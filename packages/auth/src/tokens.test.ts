import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import { sha256hex } from "./secret";
import type { ApiTokenRow } from "./tokens";
import {
  createApiToken,
  generateTokenSecret,
  getApiTokenById,
  getApiTokenWithOwner,
  hashToken,
  listOrgTokens,
  listOrgTokensOwnedBy,
  recordTokenLastUsed,
  resolveToken,
  revokeToken,
  rotateToken,
  TOKEN_PREFIX,
} from "./tokens";

function tokenRow(overrides: Record<string, unknown> = {}): ApiTokenRow {
  return {
    id: "tok-1",
    name: "ci",
    orgId: "org-1",
    ownerUserId: null,
    revokedAt: null,
    expiresAt: null,
    grants: [],
    role: null,
    type: "personal",
    ...overrides,
  } as unknown as ApiTokenRow;
}

describe("token secret helpers", () => {
  test("hashToken is a sha256 hex digest of the secret", () => {
    expect(hashToken("hoot_abc")).toBe(sha256hex("hoot_abc"));
  });

  test("generateTokenSecret yields a prefixed secret, 12-char prefix, and matching hash", () => {
    const { secret, prefix, hash } = generateTokenSecret();
    expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(prefix).toBe(secret.slice(0, 12));
    expect(hash).toBe(sha256hex(secret));
  });
});

describe("createApiToken", () => {
  test("persists hash/prefix and defaults, returning the row and raw secret", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([tokenRow({ id: "tok-created" })]);
      const { token, secret } = await createApiToken({ orgId: "org-1", name: "ci" });
      expect(token.id).toBe("tok-created");
      expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
      const values = fake.queries[0]!.values as Record<string, unknown>;
      expect(values.tokenHash).toBe(sha256hex(secret));
      expect(values.tokenPrefix).toBe(secret.slice(0, 12));
      expect(values.type).toBe("personal");
      expect(values.grants).toEqual([]);
      expect(values.ownerUserId).toBeNull();
    });
  });

  test("forwards explicit owner, type, grants, role, and expiry", async () => {
    await withFakeDb(db, async (fake) => {
      const expiresAt = new Date("2030-01-01T00:00:00.000Z");
      fake.queue([tokenRow()]);
      await createApiToken({
        orgId: "org-1",
        name: "robot",
        ownerUserId: "owner-1",
        type: "robot",
        grants: [{ resource: "repository", repository: "acme/*", actions: ["read"] }],
        role: "admin",
        expiresAt,
      });
      const values = fake.queries[0]!.values as Record<string, unknown>;
      expect(values).toMatchObject({
        ownerUserId: "owner-1",
        type: "robot",
        role: "admin",
        expiresAt,
      });
      expect(values.grants).toHaveLength(1);
    });
  });

  test("throws when the insert returns no row", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      await expect(createApiToken({ orgId: "org-1", name: "x" })).rejects.toThrow(
        "failed to create token",
      );
    });
  });
});

describe("token lookups", () => {
  test("getApiTokenById returns the row or null", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([tokenRow({ id: "found" })]);
      expect((await getApiTokenById("found"))?.id).toBe("found");
      fake.queue([]);
      expect(await getApiTokenById("missing")).toBeNull();
    });
  });

  test("getApiTokenWithOwner returns the joined row or null", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ token: tokenRow(), ownerUsername: "alice" }]);
      expect(await getApiTokenWithOwner("tok-1")).toEqual({
        token: tokenRow(),
        ownerUsername: "alice",
      });
      fake.queue([]);
      expect(await getApiTokenWithOwner("nope")).toBeNull();
    });
  });

  test("listOrgTokens / listOrgTokensOwnedBy return the joined rows", async () => {
    await withFakeDb(db, async (fake) => {
      const rows = [{ token: tokenRow(), ownerUsername: null }];
      fake.queue(rows);
      expect(await listOrgTokens("org-1")).toBe(rows);
      fake.queue(rows);
      expect(await listOrgTokensOwnedBy("org-1", "owner-1")).toBe(rows);
    });
  });
});

describe("recordTokenLastUsed debounce", () => {
  test("writes on first use, suppresses within the interval, writes again after it", async () => {
    await withFakeDb(db, async (fake) => {
      const id = `debounce-${crypto.randomUUID()}`;
      const t0 = Date.UTC(2026, 0, 1);
      expect(await recordTokenLastUsed(id, t0)).toBe(true);
      // Within 60s -> suppressed, no new query recorded.
      const after = fake.queries.length;
      expect(await recordTokenLastUsed(id, t0 + 30_000)).toBe(false);
      expect(fake.queries.length).toBe(after);
      // After the interval -> writes again.
      expect(await recordTokenLastUsed(id, t0 + 60_000)).toBe(true);
      expect(fake.queries.length).toBe(after + 1);
    });
  });
});

describe("resolveToken", () => {
  test("rejects secrets without the hoot_ prefix without querying", async () => {
    await withFakeDb(db, async (fake) => {
      expect(await resolveToken("not-a-token")).toBeNull();
      expect(fake.queries.length).toBe(0);
    });
  });

  test("returns a token principal for a live ownerless token", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ token: tokenRow({ id: "tok-x", type: "robot" }), ownerIsActive: null }]);
      const principal = await resolveToken("hoot_secret");
      expect(principal).toMatchObject({
        kind: "token",
        tokenId: "tok-x",
        orgId: "org-1",
        ownerUserId: null,
        ownerUsername: null,
        isRobot: true,
      });
    });
  });

  test("returns the owner username for an active owner-backed token", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([
        {
          token: tokenRow({ ownerUserId: "owner-1" }),
          ownerIsActive: true,
          ownerUsername: "alice",
        },
      ]);
      const principal = await resolveToken("hoot_secret");
      expect(principal).toMatchObject({ ownerUserId: "owner-1", ownerUsername: "alice" });
    });
  });

  test("returns null for missing, revoked, expired, or disabled-owner tokens", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await resolveToken("hoot_a")).toBeNull();
      fake.queue([{ token: tokenRow({ revokedAt: new Date() }), ownerIsActive: null }]);
      expect(await resolveToken("hoot_b")).toBeNull();
      fake.queue([
        { token: tokenRow({ expiresAt: new Date(Date.now() - 1000) }), ownerIsActive: null },
      ]);
      expect(await resolveToken("hoot_c")).toBeNull();
      fake.queue([
        { token: tokenRow({ ownerUserId: "owner-1" }), ownerIsActive: false, ownerUsername: "x" },
      ]);
      expect(await resolveToken("hoot_d")).toBeNull();
    });
  });
});

describe("revokeToken / rotateToken", () => {
  test("revokeToken records actor and reason in the update set", async () => {
    await withFakeDb(db, async (fake) => {
      await revokeToken("tok-1", { userId: "admin-1" }, "compromised");
      const set = fake.queries[0]!.set as Record<string, unknown>;
      expect(set).toMatchObject({
        revokedByUserId: "admin-1",
        revokedByTokenId: null,
        revocationReason: "compromised",
      });
      expect(set.revokedAt).toBeInstanceOf(Date);
    });
  });

  test("rotateToken returns a fresh secret and the updated row, or null when none updated", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([tokenRow({ id: "rotated" })]);
      const rotated = await rotateToken("tok-1", { tokenId: "actor-tok" });
      expect(rotated?.token.id).toBe("rotated");
      expect(rotated?.secret.startsWith(TOKEN_PREFIX)).toBe(true);
      const set = fake.queries[0]!.set as Record<string, unknown>;
      expect(set.tokenHash).toBe(sha256hex(rotated!.secret));
      expect(set.rotatedByTokenId).toBe("actor-tok");

      fake.queue([]);
      expect(await rotateToken("tok-missing")).toBeNull();
    });
  });
});
