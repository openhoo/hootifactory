import { describe, expect, test } from "bun:test";
import { randomSecret, sha256hex } from "./secret";

describe("secret primitives", () => {
  test("sha256hex returns a stable 64-char lowercase hex digest", () => {
    const digest = sha256hex("hootifactory");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: hashing the same input twice yields the same digest.
    expect(sha256hex("hootifactory")).toBe(digest);
    expect(sha256hex("different")).not.toBe(digest);
  });

  test("randomSecret produces a high-entropy base64url string with no prefix by default", () => {
    const secret = randomSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes -> 43 base64url chars (no padding).
    expect(secret.length).toBe(43);
    expect(randomSecret()).not.toBe(secret);
  });

  test("randomSecret prepends the supplied prefix", () => {
    const secret = randomSecret("hoot_");
    expect(secret.startsWith("hoot_")).toBe(true);
    expect(secret.slice("hoot_".length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
