import { describe, expect, test } from "bun:test";
import {
  asError,
  Errors,
  errorMessage,
  HttpError,
  isUniqueViolation,
  RegistryError,
  type RegistryErrorCode,
} from "./errors";

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

  test("captures HTTP error response metadata without exposing 5xx details by default", () => {
    const cause = new Error("database unavailable");
    const badRequest = new HttpError(400, "BAD_REQUEST", "invalid request");
    const serverError = new HttpError(503, "DATABASE_UNAVAILABLE", "database unavailable", {
      cause,
      detail: { retryable: true },
    });

    expect(badRequest).toBeInstanceOf(Error);
    expect(badRequest.expose).toBe(true);
    expect(serverError.status).toBe(503);
    expect(serverError.code).toBe("DATABASE_UNAVAILABLE");
    expect(serverError.expose).toBe(false);
    expect(serverError.detail).toEqual({ retryable: true });
    expect(serverError.cause).toBe(cause);
  });

  test("normalizes unknown thrown values for logging", () => {
    const err = new Error("boom");

    expect(asError(err)).toBe(err);
    expect(asError("boom").message).toBe("boom");
    expect(errorMessage(123)).toBe("123");
  });

  test("detects nested Postgres unique constraint errors", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { errno: 23505 } } })).toBe(true);
    expect(isUniqueViolation({ errno: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("duplicate key value violates unique constraint"))).toBe(
      true,
    );
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("nope")).toBe(false);
  });

  test("each Errors factory builds a RegistryError with the documented status and code", () => {
    const cases: Array<[() => RegistryError, number, RegistryErrorCode]> = [
      [Errors.blobUnknown, 404, "BLOB_UNKNOWN"],
      [Errors.blobUploadInvalid, 416, "BLOB_UPLOAD_INVALID"],
      [Errors.blobUploadUnknown, 404, "BLOB_UPLOAD_UNKNOWN"],
      [Errors.manifestUnknown, 404, "MANIFEST_UNKNOWN"],
      [Errors.manifestInvalid, 400, "MANIFEST_INVALID"],
      [Errors.manifestBlobUnknown, 404, "MANIFEST_BLOB_UNKNOWN"],
      [Errors.nameUnknown, 404, "NAME_UNKNOWN"],
      [Errors.nameInvalid, 400, "NAME_INVALID"],
      [Errors.tagInvalid, 400, "TAG_INVALID"],
      [Errors.paginationNumberInvalid, 400, "PAGINATION_NUMBER_INVALID"],
      [Errors.digestInvalid, 400, "DIGEST_INVALID"],
      [Errors.sizeInvalid, 400, "SIZE_INVALID"],
      [Errors.unauthorized, 401, "UNAUTHORIZED"],
      [Errors.denied, 403, "DENIED"],
      [Errors.unsupported, 400, "UNSUPPORTED"],
      [Errors.notFound, 404, "NOT_FOUND"],
      [Errors.quotaExceeded, 403, "DENIED"],
    ];

    for (const [factory, status, code] of cases) {
      const error = factory();
      expect(error).toBeInstanceOf(RegistryError);
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  test("Errors factories thread the detail payload through to the instance", () => {
    const detail = { reason: "test" };
    expect(Errors.blobUnknown(detail).detail).toBe(detail);
    expect(Errors.quotaExceeded(detail).detail).toBe(detail);
  });

  test("toResponse defaults a missing detail to null", async () => {
    const response = Errors.notFound().toResponse();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      errors: [{ code: "NOT_FOUND", message: "not found", detail: null }],
    });
  });
});
