import { describe, expect, mock, test } from "bun:test";

// Hermetically stub the DB-backed shared throttle bucket so we can drive the
// throttled/unthrottled branches of authenticateUserPasswordWithThrottle
// without Postgres. The bucket result is controlled per-call via the queue.
const sharedBucketResults: Array<
  | { throttled: false; bucket: { count: number; resetAt: number } }
  | { throttled: true; retryAfter: number }
> = [];
let clearSharedCalls = 0;

mock.module("@hootifactory/auth", () => ({
  authenticateUserPassword: async () => null,
  consumeSharedAuthThrottleBucket: async () => {
    const next = sharedBucketResults.shift();
    if (!next) throw new Error("no shared throttle bucket result queued");
    return next;
  },
  clearSharedAuthThrottleBucket: async () => {
    clearSharedCalls += 1;
  },
}));

const {
  authenticateUserPasswordWithThrottle,
  currentThrottleBucket,
  loginIdentityThrottleKey,
  loginThrottleKey,
  oidcLinkIdentityThrottleKey,
  passwordResetIdentityThrottleKey,
  pruneThrottleBuckets,
  registrationEmailThrottleKey,
  registrationUsernameThrottleKey,
  retryAfterSeconds,
} = await import("./auth-throttle");

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

describe("authenticateUserPasswordWithThrottle", () => {
  test("rejects throttled attempts before running verify (#213)", async () => {
    // Identity bucket reports throttled on the very first check.
    sharedBucketResults.length = 0;
    sharedBucketResults.push({ throttled: true, retryAfter: 42 });
    clearSharedCalls = 0;

    let verifyCalls = 0;
    const verify = async () => {
      verifyCalls += 1;
      // Even a correct guess must not authenticate while throttled.
      return { kind: "user" as const, userId: "user_1", username: "victim" };
    };

    const result = await authenticateUserPasswordWithThrottle(
      "victim",
      "right-password",
      "203.0.113.10",
      verify,
    );

    // No argon2id evaluation happens on throttled attempts, so the brute-force
    // budget bounds the number of password guesses.
    expect(verifyCalls).toBe(0);
    expect(clearSharedCalls).toBe(0);
    expect(result).toEqual({ kind: "throttled", retryAfter: 42 });
  });

  test("runs verify when within the throttle budget", async () => {
    // Identity + client buckets both report not throttled.
    sharedBucketResults.length = 0;
    sharedBucketResults.push(
      { throttled: false, bucket: { count: 1, resetAt: 1_000 } },
      { throttled: false, bucket: { count: 1, resetAt: 1_000 } },
    );

    let verifyCalls = 0;
    const verify = async () => {
      verifyCalls += 1;
      return null;
    };

    const result = await authenticateUserPasswordWithThrottle(
      "user",
      "wrong",
      "203.0.113.11",
      verify,
    );

    expect(verifyCalls).toBe(1);
    expect(result).toMatchObject({ kind: "invalid", failure: { count: 1 } });
  });
});
