import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  clearCompressedResponseCacheForTest,
  compressedResponseCacheSizeForTest,
  compressRegistryResponse,
  registryHandlerSupportsCompression,
} from "./response-compression";

const TEXT_BODY = JSON.stringify({
  name: "pkg",
  readme: "repeatable metadata ".repeat(256),
});

function gzipRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://registry.test/npm/pkg", {
    headers: { "accept-encoding": "br, gzip", ...headers },
  });
}

function textResponse(body = TEXT_BODY): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      etag: '"body-v1"',
    },
  });
}

describe("registry response compression", () => {
  test("compresses negotiated text metadata and marks the encoding variant", async () => {
    clearCompressedResponseCacheForTest();

    const compressed = await compressRegistryResponse(gzipRequest(), textResponse(), {
      format: "npm",
      handlerId: "packument",
    });

    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
    expect(compressed.headers.get("etag")).toBe('"body-v1"');
    expect(compressed.headers.get("content-length")).toBeTruthy();
    expect(gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString("utf8")).toBe(
      TEXT_BODY,
    );
  });

  test("reuses cached gzip bytes for the same etag and content type", async () => {
    clearCompressedResponseCacheForTest();

    const opts = { format: "npm", handlerId: "packument" };
    await compressRegistryResponse(gzipRequest(), textResponse(), opts);
    expect(compressedResponseCacheSizeForTest()).toBe(1);

    await compressRegistryResponse(
      gzipRequest(),
      textResponse("different body same validator"),
      opts,
    );
    expect(compressedResponseCacheSizeForTest()).toBe(1);
  });

  test("skips unsafe or uncacheable responses", async () => {
    clearCompressedResponseCacheForTest();

    const head = await compressRegistryResponse(
      new Request("https://registry.test/npm/pkg", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      }),
      textResponse(),
      { format: "npm", handlerId: "packument" },
    );
    expect(head.headers.get("content-encoding")).toBeNull();

    const noEtag = await compressRegistryResponse(
      gzipRequest(),
      new Response(TEXT_BODY, { headers: { "content-type": "application/json" } }),
      { format: "npm", handlerId: "packument" },
    );
    expect(noEtag.headers.get("content-encoding")).toBeNull();

    const binary = await compressRegistryResponse(
      gzipRequest(),
      new Response(TEXT_BODY, {
        headers: { "content-type": "application/octet-stream", etag: '"blob"' },
      }),
      { format: "npm", handlerId: "packument" },
    );
    expect(binary.headers.get("content-encoding")).toBeNull();
  });

  test("preserves small responses when gzip would be larger", async () => {
    const response = await compressRegistryResponse(
      gzipRequest(),
      textResponse("v1.0.0\n"),
      { format: "go", handlerId: "list" },
    );

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.text()).toBe("v1.0.0\n");
  });

  test("only opts in known registry metadata handlers", async () => {
    expect(registryHandlerSupportsCompression("npm", "packument")).toBe(true);
    expect(registryHandlerSupportsCompression("go", "file")).toBe(true);
    expect(registryHandlerSupportsCompression("docker", "getManifest")).toBe(false);

    const response = await compressRegistryResponse(gzipRequest(), textResponse(), {
      format: "npm",
      handlerId: "tarball",
    });
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});
