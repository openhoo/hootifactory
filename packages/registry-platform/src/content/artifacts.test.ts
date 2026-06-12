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
      },
      async () => false,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BYTES");
  });
});

describe("blob security headers are non-overridable", () => {
  test("extraHeaders cannot downgrade the attachment disposition or nosniff", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "text/html",
        extraHeaders: {
          "content-disposition": "inline",
          "x-content-type-options": "off",
        },
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      },
      async () => false,
    );
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sha256_deadbeef"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("differently-cased extra headers cannot smuggle a second disposition value", async () => {
    // `Headers` merges duplicate keys case-insensitively, so a mixed-case
    // override must be dropped entirely rather than merely out-ordered.
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        extraHeaders: {
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "off",
        },
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      },
      async () => false,
    );
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sha256_deadbeef"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("legitimately overridable headers (etag) still win over the defaults", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "application/octet-stream",
        extraHeaders: { etag: '"shasum-etag"', "x-checksum-md5": "abc123" },
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      },
      async () => false,
    );
    expect(res.headers.get("etag")).toBe('"shasum-etag"');
    expect(res.headers.get("x-checksum-md5")).toBe("abc123");
  });

  test("downloadFilename customizes — and sanitizes — the attachment filename", async () => {
    const res = await serveBlobWithScanGate(
      ctxForBlobResponse(),
      {
        digest: "sha256:deadbeef",
        contentType: "application/zip",
        downloadFilename: 'Linked"List\r\n-1.0.0.zip',
        blocked: () => new Response("blocked by scan policy", { status: 403 }),
      },
      async () => false,
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Linked_List__-1.0.0.zip"',
    );
  });
});
