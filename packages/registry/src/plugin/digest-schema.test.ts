import { describe, expect, test } from "bun:test";
import { SHA256_HEX_RE, Sha256DigestSchema, Sha256HexSchema } from "./digest-schema";

const HEX = "a".repeat(64);
const DIGEST = `sha256:${HEX}`;

describe("Sha256HexSchema", () => {
  test("accepts a bare 64-char lowercase hex string", () => {
    expect(Sha256HexSchema.parse(HEX)).toBe(HEX);
  });

  test("rejects the prefixed form, wrong length, and uppercase", () => {
    expect(Sha256HexSchema.safeParse(DIGEST).success).toBe(false);
    expect(Sha256HexSchema.safeParse("a".repeat(63)).success).toBe(false);
    expect(Sha256HexSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(Sha256HexSchema.safeParse(`${HEX} `).success).toBe(false);
  });
});

describe("Sha256DigestSchema", () => {
  test("accepts the canonical sha256:<hex> form", () => {
    expect(Sha256DigestSchema.parse(DIGEST)).toBe(DIGEST);
  });

  test("rejects bare hex, wrong prefix, and trailing junk", () => {
    expect(Sha256DigestSchema.safeParse(HEX).success).toBe(false);
    expect(Sha256DigestSchema.safeParse(`sha512:${HEX}`).success).toBe(false);
    expect(Sha256DigestSchema.safeParse(`${DIGEST}\n`).success).toBe(false);
  });
});

describe("SHA256_HEX_RE", () => {
  test("matches 64 lowercase hex chars only", () => {
    expect(SHA256_HEX_RE.test(HEX)).toBe(true);
    expect(SHA256_HEX_RE.test("g".repeat(64))).toBe(false);
  });
});
