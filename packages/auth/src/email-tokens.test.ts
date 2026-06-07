import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import {
  consumeAuthEmailToken,
  createAuthEmailToken,
  generateAuthEmailTokenSecret,
  hashAuthEmailToken,
  resetPasswordWithToken,
} from "./email-tokens";
import { withFakeDb } from "./fake-db";
import { sha256hex } from "./secret";

describe("auth email token secret helpers", () => {
  test("generateAuthEmailTokenSecret uses the hoot_email_ prefix", () => {
    expect(generateAuthEmailTokenSecret().startsWith("hoot_email_")).toBe(true);
  });

  test("hashAuthEmailToken is a sha256 hex digest", () => {
    expect(hashAuthEmailToken("hoot_email_abc")).toBe(sha256hex("hoot_email_abc"));
  });
});

describe("createAuthEmailToken", () => {
  test("invalidates prior tokens then inserts a new hashed token in one transaction", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // the invalidation update
      fake.queue([{ id: "tok-1", purpose: "password_reset", userId: "u1" }]); // the insert
      const { token, secret } = await createAuthEmailToken({
        purpose: "password_reset",
        userId: "u1",
        email: "a@b.test",
        ttlSeconds: 60,
        metadata: { foo: "bar" },
      });
      expect(token.id).toBe("tok-1");
      expect(secret.startsWith("hoot_email_")).toBe(true);

      const [invalidate, insert] = fake.queries;
      expect(invalidate!.kind).toBe("update");
      expect(insert!.kind).toBe("insert");
      const values = insert!.values as Record<string, unknown>;
      expect(values.tokenHash).toBe(sha256hex(secret));
      expect(values.metadata).toEqual({ foo: "bar" });
    });
  });

  test("throws when the insert returns no row", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // invalidation
      fake.queue([]); // insert returns nothing
      await expect(
        createAuthEmailToken({ purpose: "oidc_link", userId: "u1", email: "a@b", ttlSeconds: 1 }),
      ).rejects.toThrow("failed to create auth email token");
    });
  });
});

describe("consumeAuthEmailToken", () => {
  test("returns the consumed row when the update matched", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "tok-1", userId: "u1" }]);
      const row = await consumeAuthEmailToken("oidc_link", "secret");
      expect(row?.id).toBe("tok-1");
      expect(fake.queries[0]!.kind).toBe("update");
    });
  });

  test("returns null when no live token matched", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await consumeAuthEmailToken("oidc_link", "secret")).toBeNull();
    });
  });
});

describe("resetPasswordWithToken", () => {
  test("consumes the token, rehashes the password, and revokes sessions", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "tok-1", userId: "user-9" }]); // consume token
      fake.queue([]); // password update
      fake.queue([]); // session revocation
      const result = await resetPasswordWithToken("secret", "new-password");
      expect(result).toEqual({ userId: "user-9" });

      const [consume, pwUpdate, sessionUpdate] = fake.queries;
      expect(consume!.kind).toBe("update");
      expect(pwUpdate!.kind).toBe("update");
      const pwSet = pwUpdate!.set as Record<string, unknown>;
      expect(typeof pwSet.passwordHash).toBe("string");
      expect(pwSet.passwordHash).not.toBe("new-password");
      expect(sessionUpdate!.kind).toBe("update");
    });
  });

  test("returns null and performs no further writes when the token is invalid", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // consume matched nothing
      expect(await resetPasswordWithToken("secret", "pw")).toBeNull();
      // Only the consume attempt should have been issued.
      expect(fake.queries).toHaveLength(1);
    });
  });
});
