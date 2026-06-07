import { describe, expect, test } from "bun:test";
import * as storage from "./index";

/**
 * The barrel wires the public surface and constructs the default, env-configured
 * `blobStore`. Bun's S3 client connects lazily, so importing the module opens no
 * socket — we only assert the exported shape, not any network behavior.
 */

describe("storage package barrel", () => {
  test("re-exports digest helpers, the store class, and types", () => {
    expect(typeof storage.computeDigest).toBe("function");
    expect(typeof storage.blobKey).toBe("function");
    expect(typeof storage.stagingKey).toBe("function");
    expect(typeof storage.S3BlobStore).toBe("function");
  });

  test("exposes a default process-wide blobStore instance", () => {
    expect(storage.blobStore).toBeInstanceOf(storage.S3BlobStore);
    // The default store derives the canonical CAS key for a digest.
    expect(storage.blobStore.blobKey(storage.computeDigest("x"))).toMatch(/^blobs\/sha2\//);
  });
});
