import { expect, test } from "@playwright/test";
import { setupOwner } from "./helpers";
import {
  assertNoRangeSupport,
  assertOciRangeSupport,
  publishCargoFixture,
  publishGoFixture,
  publishNpmFixture,
  publishNugetFixture,
  publishOciBlob,
  publishPypiFixture,
} from "./transport-helpers";

/**
 * Byte-range transport. Only the OCI/Docker blob endpoint implements explicit
 * ranges (oci-blobs.ts buildOciBlobResponse + storage getRange); the generic
 * serve path used by every other format streams the whole object with no range
 * logic, so those endpoints ignore Range and always return the full 200.
 */
test.describe("blob byte-range transport", () => {
  test("OCI blob serves single, open-ended and suffix ranges and rejects oob/multi-range", async ({
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const owner = await setupOwner(baseURL!);
    const bytes = Buffer.from("oci-ranged-blob-payload-0123456789-abcdefghij-KLMNOPQRST");
    const blob = await publishOciBlob(owner, bytes);

    const { size, full } = await assertOciRangeSupport(owner.ctx, blob.blobUrl);
    expect(size).toBe(bytes.length);
    expect(full).toEqual(bytes);

    // A full GET advertises the digest, an ETag, and accept-ranges.
    const res = await owner.ctx.get(blob.blobUrl);
    expect(res.headers()["docker-content-digest"]).toBe(blob.digest);
    expect(res.headers().etag).toBe(`"${blob.digest}"`);
    expect(res.headers()["accept-ranges"]).toBe("bytes");
  });

  test("OCI zero-length blob round-trips and any range on an empty blob is 416", async ({
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const owner = await setupOwner(baseURL!);
    const blob = await publishOciBlob(owner, Buffer.alloc(0));

    // A full (non-range) blob GET streams a raw ReadableStream, which Bun sends
    // chunked with content-length stripped; the body is still empty.
    const get = await owner.ctx.get(blob.blobUrl);
    expect(get.status()).toBe(200);
    expect(Buffer.from(await get.body()).length).toBe(0);

    // HEAD keeps the explicit content-length (0) and advertises accept-ranges.
    const head = await owner.ctx.head(blob.blobUrl);
    expect(head.status()).toBe(200);
    expect(head.headers()["content-length"]).toBe("0");
    expect(head.headers()["accept-ranges"]).toBe("bytes");

    for (const range of ["bytes=-1", "bytes=0-", "bytes=0-0"]) {
      const ranged = await owner.ctx.get(blob.blobUrl, { headers: { range } });
      expect(ranged.status(), `empty-blob range ${range}`).toBe(416);
      expect(ranged.headers()["content-range"]).toBe("bytes */0");
    }
  });

  test("npm, cargo, go, nuget and pypi artifact blobs ignore Range and stream the full object", async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const owner = await setupOwner(baseURL!);

    const npm = await publishNpmFixture(owner, baseURL!);
    await assertNoRangeSupport(owner.ctx, npm.blobUrl);

    const cargo = await publishCargoFixture(owner, baseURL!);
    await assertNoRangeSupport(owner.ctx, cargo.blobUrl);

    const go = await publishGoFixture(owner, baseURL!);
    await assertNoRangeSupport(owner.ctx, go.blobUrl);

    const nuget = await publishNugetFixture(owner, baseURL!);
    await assertNoRangeSupport(owner.ctx, nuget.blobUrl);

    const pypi = await publishPypiFixture(owner, baseURL!);
    await assertNoRangeSupport(owner.ctx, pypi.blobUrl);
  });
});
