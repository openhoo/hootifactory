import { describe, expect, test } from "bun:test";
import { serveBlobWithScanGate } from "./artifacts";

function ctxForBlobResponse(presignedUrl?: string | null) {
  return {
    getBlob: () => "BYTES",
    presignBlobGet: () => presignedUrl ?? null,
  };
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
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sha256_deadbeef"');
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("BYTES");
  });

  test("a clean artifact stays server-mediated even when a public blob URL is available", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse("https://cdn.example.test/blob"),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
        redirect: true,
      },
      async () => false,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sha256_deadbeef"');
    expect(await res.text()).toBe("BYTES");
  });

  test("a clean artifact falls back to streaming when no public blob URL is available", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(null),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
        redirect: true,
      },
      async () => false,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BYTES");
  });
});
