import { describe, expect, test } from "bun:test";
import {
  currentThrottleBucket,
  loginIdentityThrottleKey,
  loginThrottleKey,
  oidcLinkIdentityThrottleKey,
  passwordResetIdentityThrottleKey,
  pruneThrottleBuckets,
  registrationEmailThrottleKey,
  registrationUsernameThrottleKey,
  retryAfterSeconds,
} from "./auth-throttle";

// DB-backed throttle behaviour lives in auth-throttle.integration.test.ts; these
// cover the pure helpers and stay hermetic.
describe("auth throttle helpers", () => {
  test("normalizes identity keys per client address", () => {
    expect(loginThrottleKey("  Alice@example.test ", "203.0.113.5")).toBe(
      "alice@example.test\u0000203.0.113.5",
    );
    expect(loginIdentityThrottleKey("  Alice@example.test ")).toBe("alice@example.test");
    expect(passwordResetIdentityThrottleKey("  Alice@example.test ")).toBe("alice@example.test");
    expect(oidcLinkIdentityThrottleKey("  Alice@example.test ")).toBe("alice@example.test");
    expect(registrationUsernameThrottleKey("  Alice ")).toBe("alice");
    expect(registrationEmailThrottleKey("  Alice@example.test ")).toBe("alice@example.test");
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
});
