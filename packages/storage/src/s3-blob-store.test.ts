import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { S3BlobStore, waitForDrain } from "./s3-blob-store";

describe("waitForDrain listener hygiene", () => {
  test("does not accumulate error listeners across backpressure/drain cycles", async () => {
    // EventEmitter mirrors a WriteStream's once/off/emit contract well enough to
    // observe listener accumulation. Cap maxListeners low so an unbounded leak
    // would surface as a MaxListenersExceededWarning.
    const out = new EventEmitter();
    out.setMaxListeners(5);

    const warnings: string[] = [];
    const onWarning = (w: Error & { name?: string }) => {
      if (w.name === "MaxListenersExceededWarning") warnings.push(w.message);
    };
    process.on("warning", onWarning);

    try {
      // Simulate many backpressure cycles: each clears via a single `drain`.
      for (let cycle = 0; cycle < 50; cycle++) {
        const pending = waitForDrain(out as never);
        out.emit("drain");
        await pending;
        // Neither the resolved drain nor its paired error listener should linger.
        expect(out.listenerCount("error")).toBe(0);
        expect(out.listenerCount("drain")).toBe(0);
      }
    } finally {
      process.off("warning", onWarning);
    }

    expect(warnings).toEqual([]);
  });

  test("rejects on error and removes the paired drain listener", async () => {
    const out = new EventEmitter();
    const boom = new Error("write failed");
    const pending = waitForDrain(out as never);
    out.emit("error", boom);

    await expect(pending).rejects.toBe(boom);
    expect(out.listenerCount("drain")).toBe(0);
    expect(out.listenerCount("error")).toBe(0);
  });
});

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
