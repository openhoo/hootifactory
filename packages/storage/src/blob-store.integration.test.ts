import { describe, expect, test } from "bun:test";
import { computeDigest } from "./digest";
import { S3BlobStore } from "./s3-blob-store";

const store = new S3BlobStore();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("S3BlobStore (MinIO integration)", () => {
  test("put hashes, stores, dedups, reads back, ranges, presigns, deletes", async () => {
    const payload = new TextEncoder().encode(`hello hootifactory ${crypto.randomUUID()}`);
    const expectedDigest = computeDigest(payload);

    // put — fresh
    const first = await store.put(payload);
    expect(first.digest).toBe(expectedDigest);
    expect(first.deduped).toBe(false);
    expect(first.size).toBe(payload.byteLength);

    // exists + stat
    expect(await store.exists(expectedDigest)).toBe(true);
    const stat = await store.stat(expectedDigest);
    expect(stat?.size).toBe(payload.byteLength);

    // full read round-trips exactly
    const got = await store.getBytes(expectedDigest);
    expect(got).toEqual(payload);

    // range read [0,5)
    const head = await readAll(store.getRange(expectedDigest, 0, 5));
    expect(head).toEqual(payload.slice(0, 5));

    // put again — deduped, no rewrite
    const second = await store.put(payload);
    expect(second.deduped).toBe(true);
    expect(second.digest).toBe(expectedDigest);

    // presigned GET url
    const url = store.presignGet(expectedDigest, 60);
    expect(url).toMatch(/^https?:\/\//);

    // delete (GC)
    await store.delete(expectedDigest);
    expect(await store.exists(expectedDigest)).toBe(false);
  });

  test("staging key write + promote to CAS", async () => {
    const payload = new TextEncoder().encode(`staged ${crypto.randomUUID()}`);
    const digest = computeDigest(payload);
    const key = `uploads/test-${crypto.randomUUID()}`;

    await store.putAtKey(key, payload);
    expect(await store.existsKey(key)).toBe(true);

    await store.promoteToBlob(key, digest);
    expect(await store.exists(digest)).toBe(true);
    expect(await store.getBytes(digest)).toEqual(payload);

    await store.deleteKey(key);
    await store.delete(digest);
  });
});
