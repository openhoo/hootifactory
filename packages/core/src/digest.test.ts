import { describe, expect, test } from "bun:test";
import {
  assertDigest,
  blobKey,
  computeDigest,
  digestHex,
  InvalidDigestError,
  isValidDigest,
  stagingKey,
} from "./digest";

describe("digest helpers", () => {
  test("computes canonical sha256 digests", () => {
    const digest = computeDigest("hello");

    expect(digest).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(digestHex(digest)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(isValidDigest(digest)).toBe(true);
  });

  test("rejects malformed digest strings", () => {
    expect(isValidDigest("sha256:ABC")).toBe(false);
    expect(
      isValidDigest("md5:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"),
    ).toBe(false);
    expect(() => assertDigest("sha256:not-hex")).toThrow(InvalidDigestError);
  });

  test("builds stable CAS and staging keys", () => {
    const digest = computeDigest("hello");

    expect(blobKey(digest)).toBe(
      "blobs/sha2/2c/f2/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(blobKey(digest, "custom")).toBe(
      "custom/2c/f2/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(stagingKey("upload-1", "/chunk")).toBe("uploads/upload-1/chunk");
  });
});
