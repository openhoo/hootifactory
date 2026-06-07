import { describe, expect, test } from "bun:test";
import * as core from "./index";

describe("core package barrel", () => {
  test("re-exports the shared public surface", () => {
    expect(typeof core.RegistryError).toBe("function");
    expect(typeof core.HttpError).toBe("function");
    expect(typeof core.Errors).toBe("object");
    expect(typeof core.errorMessage).toBe("function");
    expect(typeof core.asError).toBe("function");
    expect(typeof core.isUniqueViolation).toBe("function");
    expect(typeof core.assertPublicHttpUrl).toBe("function");
    expect(typeof core.safeFetch).toBe("function");
    expect(typeof core.isPrivateHost).toBe("function");
    expect(typeof core.safeJsonParse).toBe("function");
    expect(typeof core.parseRegistryInput).toBe("function");
    expect(typeof core.z).toBe("object");
    expect(typeof core.memoizeByKey).toBe("function");
    expect(typeof core.BoundedLruCache).toBe("function");
    expect(typeof core.createTtlPromiseCache).toBe("function");
    expect(typeof core.InFlightDeduper).toBe("function");
    expect(typeof core.createAsyncLimiter).toBe("function");
    expect(typeof core.mapWithBoundedConcurrency).toBe("function");
    expect(typeof core.computeDigest).toBe("function");
    expect(typeof core.isValidDigest).toBe("function");
    expect(core.SHA256_PREFIX).toBe("sha256:");
    expect(typeof core.trimChar).toBe("function");
    expect(typeof core.stripTrailingSlashes).toBe("function");
  });
});
