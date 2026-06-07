import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import { hashPassword } from "./password";
import {
  authenticateUserPassword,
  createLocalUser,
  dummyPasswordResetWork,
  findPasswordResetUser,
  userPrincipalById,
} from "./users";

describe("createLocalUser", () => {
  test("hashes the password and returns the inserted row", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "user-1", username: "alice", passwordHash: "stored" }]);
      const user = await createLocalUser({
        username: "alice",
        email: "a@b.test",
        password: "pw",
        displayName: "Alice",
      });
      expect(user.id).toBe("user-1");
      const values = fake.queries[0]!.values as Record<string, unknown>;
      expect(values.username).toBe("alice");
      expect(values.displayName).toBe("Alice");
      expect(typeof values.passwordHash).toBe("string");
      expect(values.passwordHash).not.toBe("pw");
    });
  });

  test("defaults displayName to null and throws when no row comes back", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      await expect(
        createLocalUser({ username: "x", email: "x@y.test", password: "pw" }),
      ).rejects.toThrow("failed to create user");
      expect((fake.queries[0]!.values as Record<string, unknown>).displayName).toBeNull();
    });
  });
});

describe("userPrincipalById", () => {
  test("returns a user principal for an active user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "user-1", username: "alice", isActive: true }]);
      expect(await userPrincipalById("user-1")).toEqual({
        kind: "user",
        userId: "user-1",
        username: "alice",
      });
    });
  });

  test("returns null for a missing or disabled user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await userPrincipalById("missing")).toBeNull();
      fake.queue([{ id: "user-1", username: "alice", isActive: false }]);
      expect(await userPrincipalById("user-1")).toBeNull();
    });
  });
});

describe("authenticateUserPassword", () => {
  test("returns the principal when the password matches an active local user", async () => {
    const passwordHash = await hashPassword("hunter2");
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "user-1", username: "alice", isActive: true, passwordHash }]);
      expect(await authenticateUserPassword("alice", "hunter2")).toEqual({
        kind: "user",
        userId: "user-1",
        username: "alice",
      });
    });
  });

  test("returns null for a wrong password", async () => {
    const passwordHash = await hashPassword("hunter2");
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "user-1", username: "alice", isActive: true, passwordHash }]);
      expect(await authenticateUserPassword("alice", "wrong")).toBeNull();
    });
  });

  test("returns null (after timing-equalizing verify) for an unknown user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await authenticateUserPassword("ghost", "whatever")).toBeNull();
    });
  });

  test("returns null for a disabled user or an SSO-only account with no password", async () => {
    const passwordHash = await hashPassword("pw");
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u", username: "alice", isActive: false, passwordHash }]);
      expect(await authenticateUserPassword("alice", "pw")).toBeNull();
      fake.queue([{ id: "u", username: "alice", isActive: true, passwordHash: null }]);
      expect(await authenticateUserPassword("alice", "pw")).toBeNull();
    });
  });
});

describe("findPasswordResetUser", () => {
  test("returns id+email for an active local account", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "u", email: "a@b.test", isActive: true, passwordHash: "h" }]);
      expect(await findPasswordResetUser("a@b.test")).toEqual({ id: "u", email: "a@b.test" });
    });
  });

  test("returns null for missing, disabled, or SSO-only accounts", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await findPasswordResetUser("none@x.test")).toBeNull();
      fake.queue([{ id: "u", email: "a@b.test", isActive: false, passwordHash: "h" }]);
      expect(await findPasswordResetUser("a@b.test")).toBeNull();
      fake.queue([{ id: "u", email: "a@b.test", isActive: true, passwordHash: null }]);
      expect(await findPasswordResetUser("a@b.test")).toBeNull();
    });
  });
});

describe("dummyPasswordResetWork", () => {
  test("performs two read-only round-trips without writing", async () => {
    await withFakeDb(db, async (fake) => {
      await dummyPasswordResetWork();
      // One transaction select + one direct select; both are reads.
      expect(fake.queries.every((q) => q.kind === "select")).toBe(true);
      expect(fake.queries.length).toBeGreaterThanOrEqual(2);
    });
  });
});
