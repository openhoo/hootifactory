import { describe, expect, test } from "bun:test";
import { currentThrottleBucket, loginThrottleKey, retryAfterSeconds } from "./auth-throttle";

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

  test("calculates retry-after seconds with a minimum of one", () => {
    expect(retryAfterSeconds({ count: 5, resetAt: 10_100 }, 10_000)).toBe(1);
    expect(retryAfterSeconds({ count: 5, resetAt: 15_100 }, 10_000)).toBe(6);
  });
});
