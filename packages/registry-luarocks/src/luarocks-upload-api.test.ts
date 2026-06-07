import { describe, expect, test } from "bun:test";
import { UploadApiVersionRegistry, uploadApiVersionId } from "./luarocks-upload-api";

describe("upload API version id", () => {
  test("derives a stable positive integer the client can format with %d", () => {
    const id = uploadApiVersionId("ver_abc123");
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    // Stable across calls.
    expect(uploadApiVersionId("ver_abc123")).toBe(id);
    // Distinct row ids generally map to distinct ids.
    expect(uploadApiVersionId("ver_other")).not.toBe(id);
  });

  test("never yields the zero sentinel the client treats as 'no id'", () => {
    for (const seed of ["", "0", "a", "ver_", "x".repeat(40)]) {
      expect(uploadApiVersionId(seed)).toBeGreaterThan(0);
    }
  });

  test("bridges an id to its rock@version for the upload_rock step", () => {
    const registry = new UploadApiVersionRegistry();
    const id = uploadApiVersionId("ver_1");
    expect(registry.resolve(id)).toBeNull();
    registry.remember(id, { rock: "demo", version: "1.0.0-1" });
    expect(registry.resolve(id)).toEqual({ rock: "demo", version: "1.0.0-1" });
  });
});
