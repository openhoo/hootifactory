import { describe, expect, test } from "bun:test";
import { S3BlobStore } from "./s3-blob-store";

describe("S3BlobStore public presigned URLs", () => {
  test("returns null when no public endpoint is configured", () => {
    const store = new S3BlobStore({ publicEndpoint: "" });
    expect(store.publicPresignGet(`sha256:${"a".repeat(64)}`)).toBeNull();
  });

  test("signs GET URLs against the public endpoint when configured", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const store = new S3BlobStore({
      endpoint: "http://internal-s3.test",
      publicEndpoint: "https://cdn.example.test",
      region: "us-east-1",
      bucket: "bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });

    const url = store.publicPresignGet(digest, 60);
    expect(url).toBeTruthy();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("https://cdn.example.test");
    expect(parsed.pathname).toContain("/bucket/blobs/sha2/");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});
