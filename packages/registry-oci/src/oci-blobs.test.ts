import { describe, expect, test } from "bun:test";
import {
  buildOciBlobHeaders,
  buildOciBlobResponse,
  buildOciRangeNotSatisfiableResponse,
} from "./oci-blobs";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function blobResponse(input: { rangeHeader?: string | null; headOnly?: boolean } = {}) {
  const bytes = "0123456789";
  return buildOciBlobResponse({
    digest: "sha256:abc",
    size: bytes.length,
    rangeHeader: input.rangeHeader ?? null,
    headOnly: input.headOnly ?? false,
    get: () => stream(bytes),
    getRange: (start, end) => stream(bytes.slice(start, end)),
  });
}

describe("OCI blob response helpers", () => {
  test("builds stable blob headers", () => {
    expect(buildOciBlobHeaders({ digest: "sha256:abc", size: 10 })).toEqual({
      "accept-ranges": "bytes",
      "docker-content-digest": "sha256:abc",
      "content-length": "10",
      "content-type": "application/octet-stream",
    });
  });

  test("serves full blob bodies and HEAD responses", async () => {
    const full = await blobResponse();
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("10");
    expect(await full.text()).toBe("0123456789");

    const head = await blobResponse({ headOnly: true });
    expect(head.status).toBe(200);
    expect(head.headers.get("docker-content-digest")).toBe("sha256:abc");
    expect(await head.text()).toBe("");
  });

  test("serves bounded byte ranges with OCI headers", async () => {
    const response = await blobResponse({ rangeHeader: "bytes=2-5" });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  test("returns 416 responses for invalid ranges", async () => {
    const response = await blobResponse({ rangeHeader: "bytes=20-30" });

    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(response.headers.get("content-length")).toBe("0");
    expect(buildOciRangeNotSatisfiableResponse(5).headers.get("content-range")).toBe("bytes */5");
  });
});
