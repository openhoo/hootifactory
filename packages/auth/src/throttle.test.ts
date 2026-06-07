import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { withFakeDb } from "./fake-db";
import {
  clearSharedAuthThrottleBucket,
  consumeSharedAuthThrottleBucket,
  retryAfterSeconds,
  sweepExpiredAuthThrottleBuckets,
} from "./throttle";

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("retryAfterSeconds", () => {
  test("rounds up the seconds until reset and never returns less than 1", () => {
    expect(retryAfterSeconds({ count: 5, resetAt: NOW + 4200 }, NOW)).toBe(5);
    expect(retryAfterSeconds({ count: 5, resetAt: NOW - 1000 }, NOW)).toBe(1);
    expect(retryAfterSeconds({ count: 5, resetAt: NOW }, NOW)).toBe(1);
  });
});

describe("consumeSharedAuthThrottleBucket", () => {
  test("returns not-throttled while the count stays within the limit", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ count: 1, resetAt: new Date(NOW + 60_000) }]);
      const result = await consumeSharedAuthThrottleBucket({
        scope: "login",
        key: "alice",
        windowSeconds: 60,
        maxAttempts: 5,
        now: NOW,
      });
      expect(result.throttled).toBe(false);
      expect(result.bucket.count).toBe(1);
      expect(result.bucket.resetAt).toBe(NOW + 60_000);
      // It is an upsert: insert + onConflictDoUpdate, returning the row.
      expect(fake.queries[0]!.kind).toBe("insert");
      expect(fake.queries[0]!.onConflict).toBe(true);
    });
  });

  test("returns throttled with a retryAfter once the count exceeds the limit", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ count: 6, resetAt: new Date(NOW + 30_000) }]);
      const result = await consumeSharedAuthThrottleBucket({
        scope: "login",
        key: "alice",
        windowSeconds: 60,
        maxAttempts: 5,
        now: NOW,
      });
      expect(result.throttled).toBe(true);
      if (result.throttled) expect(result.retryAfter).toBe(30);
    });
  });

  test("defaults the count/resetAt and uses Date.now() when no row or now is supplied", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // no returned row -> defaults
      const before = Date.now();
      const result = await consumeSharedAuthThrottleBucket({
        scope: "reset",
        key: "bob",
        windowSeconds: 10,
        maxAttempts: 3,
      });
      expect(result.throttled).toBe(false);
      expect(result.bucket.count).toBe(1);
      // resetAt defaults to now + window.
      expect(result.bucket.resetAt).toBeGreaterThanOrEqual(before + 10_000 - 50);
    });
  });
});

describe("clearSharedAuthThrottleBucket / sweepExpiredAuthThrottleBuckets", () => {
  test("clear issues a delete keyed by the bucket hash", async () => {
    await withFakeDb(db, async (fake) => {
      await clearSharedAuthThrottleBucket("login", "alice");
      expect(fake.queries[0]!.kind).toBe("delete");
    });
  });

  test("sweep deletes expired buckets and returns how many were removed", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ bucketHash: "a" }, { bucketHash: "b" }]);
      expect(await sweepExpiredAuthThrottleBuckets(NOW)).toBe(2);
      expect(fake.queries[0]!.kind).toBe("delete");
    });
  });

  test("sweep defaults to Date.now() when no timestamp is supplied", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(await sweepExpiredAuthThrottleBuckets()).toBe(0);
    });
  });
});
