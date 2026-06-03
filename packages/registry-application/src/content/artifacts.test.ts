import { describe, expect, test } from "bun:test";
import type { RegistryRequestContext } from "@hootifactory/registry";
import { serveBlobWithScanGate } from "./artifacts";

function ctxForBlobResponse(): Pick<RegistryRequestContext, "blobs"> {
  return {
    blobs: { get: () => "BYTES" },
  } as unknown as RegistryRequestContext;
}

describe("serveBlobIfClean", () => {
  test("a blocked artifact returns blocked() even when notModified would fire", async () => {
    // Regression guard: the scan-policy block check MUST run before any 304
    // short-circuit, otherwise a quarantined artifact could be answered with a
    // cacheable 304 instead of a 403.
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
        notModified: () => new Response(null, { status: 304 }),
      },
      async () => true,
    );
    expect(res.status).toBe(403);
  });

  test("a clean artifact honors notModified before serving bytes", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
        notModified: () => new Response(null, { status: 304 }),
      },
      async () => false,
    );
    expect(res.status).toBe(304);
  });

  test("a clean artifact with no 304 serves the bytes with the given content-type", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        extraHeaders: { etag: '"abc"' },
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      },
      async () => false,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(await res.text()).toBe("BYTES");
  });
});
