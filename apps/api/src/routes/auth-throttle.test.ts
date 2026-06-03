import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  authenticateUserPasswordWithThrottle,
  currentThrottleBucket,
  loginIsThrottled,
  loginThrottleKey,
  pruneThrottleBuckets,
  retryAfterSeconds,
} from "./auth-throttle";

describe("auth throttle helpers", () => {
  test("normalizes identity keys per client address", () => {
    expect(loginThrottleKey("  Alice@example.test ", "203.0.113.5")).toBe(
      "alice@example.test\u0000203.0.113.5",
    );
  });

  test("reuses active buckets and resets expired windows", () => {
    const buckets = new Map<string, { count: number; resetAt: number }>();
    const first = currentThrottleBucket(buckets, "key", 10, 1_000);
    first.count = 3;

    expect(currentThrottleBucket(buckets, "key", 10, 5_000)).toBe(first);
    expect(currentThrottleBucket(buckets, "key", 10, 11_000)).toEqual({
      count: 0,
      resetAt: 21_000,
    });
  });

  test("prunes expired throttle buckets", () => {
    const buckets = new Map<string, { count: number; resetAt: number }>([
      ["expired", { count: 1, resetAt: 999 }],
      ["active", { count: 1, resetAt: 2_000 }],
    ]);

    pruneThrottleBuckets(buckets, 1_000, 10);

    expect([...buckets.keys()]).toEqual(["active"]);
  });

  test("evicts oldest active throttle buckets when the cache is full", () => {
    const buckets = new Map<string, { count: number; resetAt: number }>();

    currentThrottleBucket(buckets, "one", 10, 1_000, 2);
    currentThrottleBucket(buckets, "two", 10, 1_001, 2);
    currentThrottleBucket(buckets, "three", 10, 1_002, 2);

    expect([...buckets.keys()]).toEqual(["two", "three"]);
  });

  test("calculates retry-after seconds with a minimum of one", () => {
    expect(retryAfterSeconds({ count: 5, resetAt: 10_100 }, 10_000)).toBe(1);
    expect(retryAfterSeconds({ count: 5, resetAt: 15_100 }, 10_000)).toBe(6);
  });

  test("throttles shared password verification buckets", async () => {
    const username = `basic-${randomUUID()}@example.test`;
    let calls = 0;
    const verify = async () => {
      calls += 1;
      return null;
    };

    for (let attempts = 1; attempts <= 5; attempts++) {
      await expect(
        authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.10", verify),
      ).resolves.toMatchObject({ kind: "invalid", failure: { count: attempts } });
    }

    await expect(
      authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.10", verify),
    ).resolves.toMatchObject({ kind: "throttled" });
    expect(calls).toBe(5);
    expect(loginIsThrottled(loginThrottleKey(username, "203.0.113.10")).throttled).toBe(true);
  });

  test("successful shared password verification clears prior failures", async () => {
    const username = `success-${randomUUID()}@example.test`;
    await authenticateUserPasswordWithThrottle(username, "wrong", "203.0.113.11", async () => null);

    await expect(
      authenticateUserPasswordWithThrottle(username, "right", "203.0.113.11", async () => ({
        kind: "user",
        userId: "user_1",
        username,
      })),
    ).resolves.toMatchObject({ kind: "authenticated", principal: { username } });

    expect(loginIsThrottled(loginThrottleKey(username, "203.0.113.11")).throttled).toBe(false);
  });
});
