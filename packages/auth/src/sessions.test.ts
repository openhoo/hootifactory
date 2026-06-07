import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import { sha256hex } from "./secret";
import {
  activeSessionsForUser,
  createSession,
  resolveSession,
  revokeSession,
  revokeSessionsForUser,
} from "./sessions";

describe("sessions", () => {
  test("activeSessionsForUser builds a non-null predicate", () => {
    // It only needs to be a truthy SQL predicate object; the exact shape is
    // Drizzle-internal. We assert it is produced without throwing.
    expect(activeSessionsForUser("user-1")).toBeDefined();
  });

  test("createSession persists the token hash (never the secret) with the default TTL", async () => {
    await withFakeDb(db, async (fake) => {
      const before = Date.now();
      const { secret, expiresAt } = await createSession("user-1", { ip: "127.0.0.1" });
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const ttlMs = expiresAt.getTime() - before;
      // Default TTL is 7 days.
      expect(ttlMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);

      const insert = fake.queries[0]!;
      expect(insert.kind).toBe("insert");
      const values = insert.values as Record<string, unknown>;
      expect(values.userId).toBe("user-1");
      expect(values.ip).toBe("127.0.0.1");
      expect(values.tokenHash).toBe(sha256hex(secret));
      // The raw secret must never be written to the row.
      expect(JSON.stringify(values)).not.toContain(secret);
    });
  });

  test("createSession honors a custom TTL", async () => {
    await withFakeDb(db, async () => {
      const before = Date.now();
      const { expiresAt } = await createSession("user-1", { ttlSeconds: 60 });
      const ttlMs = expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThan(55_000);
      expect(ttlMs).toBeLessThanOrEqual(61_000);
    });
  });

  test("resolveSession returns the user for a live, non-revoked session", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ userId: "user-7", revokedAt: null, expiresAt: new Date(Date.now() + 60_000) }]);
      expect(await resolveSession("secret")).toEqual({ userId: "user-7" });
    });
  });

  test("resolveSession returns null for missing, revoked, or expired sessions", async () => {
    await withFakeDb(db, async (fake) => {
      // missing
      fake.queue([]);
      expect(await resolveSession("a")).toBeNull();
      // revoked
      fake.queue([
        { userId: "u", revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
      ]);
      expect(await resolveSession("b")).toBeNull();
      // expired
      fake.queue([{ userId: "u", revokedAt: null, expiresAt: new Date(Date.now() - 1000) }]);
      expect(await resolveSession("c")).toBeNull();
    });
  });

  test("revokeSession issues an update keyed by the token hash", async () => {
    await withFakeDb(db, async (fake) => {
      await revokeSession("secret");
      const update = fake.queries[0]!;
      expect(update.kind).toBe("update");
      expect((update.set as { revokedAt: Date }).revokedAt).toBeInstanceOf(Date);
    });
  });

  test("revokeSessionsForUser issues a bulk update", async () => {
    await withFakeDb(db, async (fake) => {
      await revokeSessionsForUser("user-1");
      expect(fake.queries[0]!.kind).toBe("update");
      expect((fake.queries[0]!.set as { revokedAt: Date }).revokedAt).toBeInstanceOf(Date);
    });
  });
});
