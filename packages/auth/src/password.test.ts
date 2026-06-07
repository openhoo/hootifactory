import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  test("hashPassword produces an argon2id hash that verifyPassword accepts", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("verifyPassword rejects the wrong password", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("hashing the same password twice yields distinct salted hashes", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
});
