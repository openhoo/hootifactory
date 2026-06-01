import { describe, expect, test } from "bun:test";
import { Errors, isUniqueViolation, RegistryError } from "./errors";

describe("registry errors", () => {
  test("serializes OCI error responses with detail", async () => {
    const response = Errors.manifestBlobUnknown({ missing: ["sha256:abc"] }).toResponse({
      "x-test": "1",
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-test")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      errors: [
        {
          code: "MANIFEST_BLOB_UNKNOWN",
          message: "manifest references a blob unknown to registry",
          detail: { missing: ["sha256:abc"] },
        },
      ],
    });
  });

  test("keeps error metadata on the RegistryError instance", () => {
    const error = new RegistryError(403, "DENIED", "nope", "details");

    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(403);
    expect(error.code).toBe("DENIED");
    expect(error.detail).toBe("details");
  });

  test("detects nested Postgres unique constraint errors", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { errno: 23505 } } })).toBe(true);
    expect(isUniqueViolation(new Error("duplicate key value violates unique constraint"))).toBe(
      true,
    );
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
  });
});
