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

const npmModule = {
  compressibleHandlers: new Set(["packument"]),
  compressibleContentTypes: new Set<string>(),
};
const goModule = {
  compressibleHandlers: new Set(["file", "list"]),
  compressibleContentTypes: new Set<string>(),
};
const dockerModule = {
  compressibleHandlers: new Set<string>(),
  compressibleContentTypes: new Set<string>(),
};

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
      module: npmModule,
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

    const opts = { module: npmModule, handlerId: "packument" };
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
      { module: npmModule, handlerId: "packument" },
    );
    expect(head.headers.get("content-encoding")).toBeNull();

    const noEtag = await compressRegistryResponse(
      gzipRequest(),
      new Response(TEXT_BODY, { headers: { "content-type": "application/json" } }),
      { module: npmModule, handlerId: "packument" },
    );
    expect(noEtag.headers.get("content-encoding")).toBeNull();

    const binary = await compressRegistryResponse(
      gzipRequest(),
      new Response(TEXT_BODY, {
        headers: { "content-type": "application/octet-stream", etag: '"blob"' },
      }),
      { module: npmModule, handlerId: "packument" },
    );
    expect(binary.headers.get("content-encoding")).toBeNull();
  });

  test("preserves small responses when gzip would be larger", async () => {
    const response = await compressRegistryResponse(gzipRequest(), textResponse("v1.0.0\n"), {
      module: goModule,
      handlerId: "list",
    });

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.text()).toBe("v1.0.0\n");
  });

  test("honors a wildcard accept-encoding preference and appends to an existing vary", async () => {
    clearCompressedResponseCacheForTest();

    const res = new Response(TEXT_BODY, {
      headers: {
        "content-type": "application/json",
        etag: '"vary-v1"',
        vary: "Accept",
      },
    });
    const compressed = await compressRegistryResponse(
      new Request("https://registry.test/npm/pkg", { headers: { "accept-encoding": "*" } }),
      res,
      { module: npmModule, handlerId: "packument" },
    );

    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    // appendVary must extend, not overwrite, the existing Vary header.
    expect(compressed.headers.get("vary")).toBe("Accept, Accept-Encoding");
  });

  test("skips compression when gzip is explicitly disabled via q=0", async () => {
    const res = await compressRegistryResponse(
      gzipRequest({ "accept-encoding": "gzip;q=0" }),
      textResponse(),
      { module: npmModule, handlerId: "packument" },
    );
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("skips compression for declared payloads above the response cap", async () => {
    const res = new Response(TEXT_BODY, {
      headers: {
        "content-type": "application/json",
        etag: '"huge"',
        "content-length": String(16 * 1024 * 1024),
      },
    });
    const compressed = await compressRegistryResponse(gzipRequest(), res, {
      module: npmModule,
      handlerId: "packument",
    });
    expect(compressed.headers.get("content-encoding")).toBeNull();
  });

  test("does not compress when a content-encoding is already set", async () => {
    const res = new Response(TEXT_BODY, {
      headers: {
        "content-type": "application/json",
        etag: '"pre-encoded"',
        "content-encoding": "br",
      },
    });
    const compressed = await compressRegistryResponse(gzipRequest(), res, {
      module: npmModule,
      handlerId: "packument",
    });
    expect(compressed.headers.get("content-encoding")).toBe("br");
  });

  test("only opts in known registry metadata handlers", async () => {
    expect(registryHandlerSupportsCompression(npmModule, "packument")).toBe(true);
    expect(registryHandlerSupportsCompression(goModule, "file")).toBe(true);
    expect(registryHandlerSupportsCompression(dockerModule, "getManifest")).toBe(false);

    const response = await compressRegistryResponse(gzipRequest(), textResponse(), {
      module: npmModule,
      handlerId: "tarball",
    });
    expect(response.headers.get("content-encoding")).toBeNull();
  });
});
